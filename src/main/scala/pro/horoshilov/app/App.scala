package pro.horoshilov.app

import cats.effect.concurrent.Ref
import cats.effect.{ExitCode, IO, IOApp}
import com.bot4s.telegram.models.ChatId
import pro.horoshilov.app.Retry.ExponentialBackOff
import pro.horoshilov.app.bot.Bot
import pro.horoshilov.app.service.{Count, Day, Employer, InMemoryDutyGroupStorage}

import scala.concurrent.duration._

object App extends IOApp {

  def run(args: List[String]): IO[ExitCode] =
    args match {
      case List("token", token) => for {
        t1 <- Ref.of[IO, Map[ChatId, Set[Employer]]](Map.empty)
        t2 <- Ref.of[IO, Map[ChatId, List[(Day, Set[Employer])]]](Map.empty)
        t3 <- Ref.of[IO, Map[ChatId, Count]](Map.empty)
        mem = new InMemoryDutyGroupStorage(2, t1, t2, t3)
        _ <- Retry.retryFunc("bot")(ExponentialBackOff(100, 5 seconds))(new Bot[IO](token, mem).run())
      } yield ExitCode.Success
      case _ => IO.raiseError(new Exception("Usage:\nApp token $token"))
    }
}