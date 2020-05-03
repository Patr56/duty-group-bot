package pro.horoshilov.app

import cats.effect.IO
import cats.effect.concurrent.Ref
import com.bot4s.telegram.models.ChatId
import org.scalatest.funsuite.AnyFunSuite
import org.scalatest.matchers.should.Matchers
import pro.horoshilov.app.service.{Count, Day, Employer, InMemoryDutyGroupStorage}

class InMemoryDutyGroupStorageSpec extends AnyFunSuite with Matchers {

  test("addEmp") {

    val chatId = "testChat"

    val t = for {
      t1 <- Ref.of[IO, Map[ChatId, Set[Employer]]](Map.empty)
      t2 <- Ref.of[IO, Map[ChatId, List[(Day, Set[Employer])]]](Map.empty)
      t3 <- Ref.of[IO, Map[ChatId, Count]](Map.empty)
      mem = new InMemoryDutyGroupStorage(1, t1, t2, t3)
      _ <- mem.setDutyCount(chatId, 2)
      _ <- mem.add(chatId, Set("@Pavel"))
      _ <- mem.add(chatId, Set("@Dima"))
      _ <- mem.add(chatId, Set("@Alex", "@Max", "@Tatyana"))
      res <- mem.employers(chatId)
      _ <- mem.remove(chatId, "@Alex")
      resCut <- mem.employers(chatId)
      _ <- mem.reset(chatId)
      resClear <- mem.employers(chatId)
    } yield {
      assertResult(Set("@Pavel", "@Alex", "@Dima", "@Max", "@Tatyana"))(res)
      assertResult(Set("@Pavel", "@Dima", "@Max", "@Tatyana"))(resCut)
      assertResult(Set.empty)(resClear)
    }

    t.unsafeRunSync()
  }
}
