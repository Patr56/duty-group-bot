package pro.horoshilov.app.bot

import cats.effect.{Async, ContextShift, IO, Timer}
import cats.syntax.flatMap._
import cats.syntax.functor._
import com.bot4s.telegram.api.declarative.{Commands, RegexCommands}
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

  // Extractor
  object Int {
    def unapply(s: String): Option[Int] = Try(s.toInt).toOption
  }

  onCommand("/add") { implicit msg: Message =>
    withArgs {
      case Seq(v) => for {
        _ <- storage.add(msg.chat.id, v.split(",").map(_.trim).toSet)
        _ <- reply(s"Участник $v добавлен.").void
      } yield ()

      case _ =>
        reply("Ошибка. Попробуйте: /add @user или /add @user, @user2, @user3").void
    }
  }

  onCommand("/set") { implicit msg =>
    withArgs {
      case Seq(Int(count)) =>
        for {
          _ <- storage.setDutyCount(msg.chat.id, count)
          _ <- reply(s"Количество дежурных: $count").void
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
          |Добавьте сперва /add @user""".stripMargin else employers.mkString("Сотрудники: ", ", ", ".")).void
    } yield ()
  }

  onCommand("/duty") { implicit msg: Message =>
    for {
      v <- storage.duty(msg.chat.id)
      _ <- reply(if (v.isEmpty)
        """Дежурных нет.
          | Добавьте сперва /add @user""".stripMargin else v.mkString("Дежурные: ", ", ", ".")).void
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
      _ <- reply("Дежурные удалены")
    } yield ()
  }

  onCommand("/help" | "/start") { implicit msg: Message =>
    reply(
      """
        |/set 2 - выставляет количество дежурных.
        |/add @employer[, @employerN] - добавить участников.
        |/remove @employer - удалить участника.
        |/list - список участников.
        |/reset - очистить участников.
        |/duty - выбрать участников.
        |""".stripMargin).void
  }
}

