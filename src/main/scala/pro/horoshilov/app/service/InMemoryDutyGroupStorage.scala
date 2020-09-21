package pro.horoshilov.app.service

import cats.Functor
import cats.effect.Sync
import cats.effect.concurrent.Ref
import cats.implicits._
import com.bot4s.telegram.models.ChatId

import scala.util.Random

class InMemoryDutyGroupStorage[F[_] : Functor](
                                                val default: Count,
                                                private val employersRef: Ref[F, Map[ChatId, Set[Employer]]],
                                                private val employersHistoryRef: Ref[F, Map[ChatId, List[(Day, Set[Employer])]]],
                                                private val dutyRef: Ref[F, Map[ChatId, Count]]
                                              )(implicit F: Sync[F]) extends DutyGroupStorage[F] {

  /** Добавить дежурного. */
  override def add(chatId: ChatId, newEmployers: Set[Employer]): F[Unit] = {
    employersRef.update(v => {
      v + (chatId -> v.getOrElse(chatId, Set.empty) match {
        case (id: ChatId, employers) => (id, employers ++ newEmployers)
      })
    })
  }

  private def saveDutyToHistory(chatId: ChatId, duty: Set[Employer]): F[Unit] = {
    employersHistoryRef.update(v => v + (chatId -> v.getOrElse(chatId, List.empty) match {
      case (id: ChatId, history) => (id, (System.currentTimeMillis(), duty) :: history)
    }))
  }

  /** Список всех дежурных. */
  override def employers(chatId: ChatId): F[Set[Employer]] = employersRef.get.map(_.getOrElse(chatId, Set.empty))

  /** Установить количество дежурных. */
  override def setDutyCount(chatId: ChatId, count: Count): F[Unit] = {
    dutyRef.update(v => v + (chatId -> count)
    )
  }

  /** Сбросить все настройки. */
  override def reset(chatId: ChatId): F[Unit] = {
    employersRef.update(v => v + (chatId -> Set.empty))
  }

  /** Удалить дежурного. */
  override def remove(chatId: ChatId, employer: Employer): F[Unit] = {
    employersRef.update(v => {
      v + (chatId -> v.getOrElse(chatId, Set.empty) match {
        case (id: ChatId, employers) => (id, employers.filterNot(_.contains(employer)))
      })
    })
  }

  /** Назначить дежурных. */
  override def assignDuty(chatId: ChatId): F[Set[Employer]] = {
    for {
      count <- getCountDuty(chatId)
      previous <- duty(chatId)
      dutyEmp <- employersRef.get.map(_.getOrElse(chatId, Set.empty).toList.diff(previous.toList)).map(Random.shuffle(_).take(count).toSet)
      _ <- saveDutyToHistory(chatId, dutyEmp)
    } yield dutyEmp
  }

  private def getCountDuty(chatId: ChatId): F[Count] = {
    dutyRef.get.map(_.getOrElse(chatId, default))
  }

  /** Получить историю назначенных дежурных. */
  override def history(chatId: ChatId): F[List[(Day, Set[Employer])]] =
    employersHistoryRef.get.map(_.getOrElse(chatId, List.empty))

  /** Получить дежурных. */
  override def duty(chatId: ChatId): F[Set[Employer]] = {
    for {
      current <- history(chatId).map(_.headOption.getOrElse((0, Set.empty[Employer]))._2)
    } yield current
  }

  /** Список чатов. */
  override def chats(): F[Set[ChatId]] = {
    dutyRef.get.map(_.keySet)
  }
}