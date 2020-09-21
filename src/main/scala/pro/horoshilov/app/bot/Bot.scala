package pro.horoshilov.app.bot

import cats._
import cats.data._
import cats.implicits._
import java.text.SimpleDateFormat
import java.time.LocalTime
import java.util.{Date, TimeZone}

import cats.data.OptionT
import cats.effect.{Async, ContextShift, IO, Timer}
import cats.effect.Sync
import cats.syntax.flatMap._
import cats.syntax.functor._
import com.bot4s.telegram.api.declarative.{Args, Commands, RegexCommands}
import com.bot4s.telegram.cats.Polling
import com.bot4s.telegram.models.{Chat, ChatId, ChatType, Message}
import cron4s.Cron
import pro.horoshilov.app.service.DutyGroupStorage
import fs2.Stream
import eu.timepit.fs2cron.awakeEveryCron

import scala.collection.immutable
import scala.concurrent.ExecutionContext
import scala.util.{Random, Try}

class Bot[F[_] : Async : Timer : ContextShift](token: String, storage: DutyGroupStorage[F]) extends DefaultBot[F](token)
  with Polling[F]
  with Commands[F]
  with RegexCommands[F] {

  implicit val timer: Timer[IO] = IO.timer(ExecutionContext.global)
  val date = new SimpleDateFormat("yyyy.MM.dd HH:mm")
  date.setTimeZone(TimeZone.getTimeZone("Europe/Moscow"))

  // Extractor
  object Int {
    def unapply(s: String): Option[Int] = Try(s.toInt).toOption
  }

  onCommand("/add") { implicit msg: Message =>
    withArgs {
      case args: Args =>
        val employers = args.mkString("").split(",").map(_.trim).filterNot(_.isEmpty).sorted.toSet
        for {
          _ <- storage.add(msg.chat.id, employers)
          _ <- reply(s"Участник${m(employers, "", "и")} ${employers.mkString(", ")} добавлен${m(employers, "", "ы")}.")
        } yield ()

      case _ =>
        reply("Ошибка. Попробуйте: /add @user или /add @user, @user2, @user3").void
    }
  }

  onCommand("/reg") { implicit msg: Message =>
    msg.from.flatMap(_.username) match {
      case Some(username) => for {
        _ <- storage.add(msg.chat.id, Set(s"@$username"))
        _ <- reply(s"Ура! @$username добавлен.").void
      } yield ()
      case None => for {
        _ <- reply("У вас нет логина.").void
      } yield ()
    }
  }

  onCommand("/unreg") { implicit msg: Message =>
    msg.from.flatMap(_.username) match {
      case Some(username) => for {
        _ <- storage.remove(msg.chat.id, s"@$username")
        _ <- reply(s"@$username удалён из дежурных.").void
      } yield ()
      case None => for {
        _ <- reply("У вас нет логина.").void
      } yield ()
    }
  }

  onCommand("/set") { implicit msg =>
    withArgs {
      case Seq(Int(count)) =>
        for {
          _ <- storage.setDutyCount(msg.chat.id, count)
          _ <- reply(s"Количество дежурных в чате: $count").void
        } yield ()

      case _ =>
        reply("Ошибка. Попробуйте: /set 2").void
    }
  }

  onCommand("/list") { implicit msg: Message =>
    for {
      employers <- storage.employers(msg.chat.id)
      _ <- reply(if (employers.isEmpty)
        """Список сотрудников пуст.
          |Добавьте сперва /add @user или /reg""".stripMargin else employers.toList.sorted.mkString("Сотрудники: ", ", ", ".")).void
    } yield ()
  }

  onCommand("/duty") { implicit msg: Message =>
    for {
      _ <- reply(
        s"""${date.format(new Date())}
           |Начинаю искать дежурных...""".stripMargin)
      v <- storage.assignDuty(msg.chat.id)
      _ <- reply(if (v.isEmpty)
        """Дежурных нет.
          | Добавьте сперва /add @user""".stripMargin else v.mkString(s"Дежурны${m(v, "й", "е")} на сегодня: ", ", ", ".")).void
    } yield ()
  }

  onCommand("/remove") { implicit msg: Message =>
    withArgs {
      case Seq(v) => for {
        _ <- storage.remove(msg.chat.id, v)
        _ <- reply(s"Удаление пользователя $v прошло успешно.").void
      } yield ()

      case _ =>
        reply("Ошибка. Попробуйте: /remove @user").void
    }
  }

  onCommand("/reset") { implicit msg: Message =>
    for {
      _ <- storage.reset(msg.chat.id)
      _ <- reply("Все дежурные удалены.")
    } yield ()
  }

  onMessage { implicit msg: Message =>
    (for {
      text <- OptionT.fromOption(msg.text) if text.toLowerCase.matches("(.*)(http|pr|пр)(.*)")
      duty <- OptionT.liftF(storage.duty(msg.chat.id)) if duty.nonEmpty
      _ <- OptionT.liftF(reply(s"Дорог${m(duty, "ой", "ие")} ${duty.mkString(", ")}, ${getWord(dictionary)} посмотри${m(duty, "", "те")} PR от ${msg.from.fold("")(_.username.fold("")(identity))}"))
    } yield ()).value.void
  }

  def m[T](emp: Set[T], one:String, some: String): String = {
    if (emp.size == 1) one else some
  }

  onCommand("/help" | "/start") { implicit msg: Message =>
    reply(
      """
        |Общие команды:
        |/duty - выбрать дежурных.
        |/reg - стать участником.
        |/unreg - уйти из участников.
        |/list - список участников.
        |/reset - очистить участников.
        |/help - очистить участников.
        |Управление:
        |/set 2 - выставляет количество дежурных.
        |/add @employer[, @employerN] - добавить участников.
        |/remove @employer - удалить участника.
        |""".stripMargin).void
  }

  def getWord(d: List[String]): String = {
    Random.shuffle(d).take(1).head
  }

  val dictionary = List(
    "пожалуйста,",
    "будьте добры,",
    "будьте любезны,",
    "если вам не трудно,",
    "если вас не затруднит,",
    "сделайте одолжение,",
    "не откажите в любезности,",
    "не сочтите за труд,",
    "будь другом,",
    "по братски,",
    "вы уж",
  )

  val everyFiveSeconds = Cron.unsafeParse("*/5 * * ? * *")

  val sendMessage: Stream[F, Unit] = Stream.eval(
    storage.chats().flatMap(chats => chats.map {
      chatId: ChatId => {
        implicit val message: Message = Message(messageId = 1, date = 1, chat = Chat(chatId.toEither.left.getOrElse(0), ChatType.Group))
        reply(s"Сообщение для чата ${chatId}").void
      }
    }.foldLeft(unit)((a, b) => b))
  )

  val scheduled: Stream[Any, Unit] = awakeEveryCron[IO](everyFiveSeconds) >> sendMessage
  scheduled.repeat.compile.drain
}

