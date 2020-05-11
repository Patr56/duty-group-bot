package pro.horoshilov.app.bot

import java.text.SimpleDateFormat
import java.util.{Date, TimeZone}

import cats.effect.{Async, ContextShift, IO, Timer}
import cats.syntax.flatMap._
import cats.syntax.functor._
import com.bot4s.telegram.api.declarative.{Args, Commands, RegexCommands}
import com.bot4s.telegram.cats.Polling
import com.bot4s.telegram.models.Message
import pro.horoshilov.app.service.DutyGroupStorage

import scala.concurrent.ExecutionContext
import scala.util.Try

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
          _ <- reply(s"Участник${if (employers.size == 1) "" else "и"} ${employers.mkString(", ")} добавлен${if (employers.size == 1) "" else "ы"}.").void
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
          |Добавьте сперва /add @user""".stripMargin else employers.toList.sorted.mkString("Сотрудники: ", ", ", ".")).void
    } yield ()
  }

  onCommand("/duty") { implicit msg: Message =>
    for {
      _ <- reply(
        s"""${date.format(new Date())}
           |Начинаю искать дежурных...""".stripMargin)
      v <- storage.duty(msg.chat.id)
      _ <- reply(if (v.isEmpty)
        """Дежурных нет.
          | Добавьте сперва /add @user""".stripMargin else v.mkString("Дежурные на сегодня: ", ", ", ".")).void
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
}

