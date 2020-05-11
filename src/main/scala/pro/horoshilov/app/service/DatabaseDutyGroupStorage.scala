package pro.horoshilov.app.service

import cats.Functor
import cats.effect.Sync
import cats.effect.concurrent.Ref
import cats.implicits._
import com.bot4s.telegram.models.ChatId

import scala.util.Random

class DatabaseDutyGroupStorage[F[_] : Functor](
                                                val default: Count,
                                              )(implicit F: Sync[F]) extends DutyGroupStorage[F] {
  /** Добавить дежурного. */
  override def add(chatId: ChatId, newEmployers: Set[Employer]): F[Unit] = ???

  /** Удалить дежурного. */
  override def remove(chatId: ChatId, item: Employer): F[Unit] = ???

  /** Список всех дежурных. */
  override def employers(chatId: ChatId): F[Set[Employer]] = ???

  /** Установить количество дежурных. */
  override def setDutyCount(chatId: ChatId, count: Count): F[Unit] = ???

  /** Сбросить все настройки. */
  override def reset(chatId: ChatId): F[Unit] = ???

  /** Получить дежурных. */
  override def duty(chatId: ChatId): F[Set[Employer]] = ???

  /** Получить историю назначенных дежурных. */
  override def history(chatId: ChatId): F[List[(Day, Set[Employer])]] = ???
}