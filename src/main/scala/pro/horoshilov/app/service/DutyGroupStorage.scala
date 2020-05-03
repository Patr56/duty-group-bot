package pro.horoshilov.app.service

import com.bot4s.telegram.models.ChatId

trait DutyGroupStorage[F[_]] {
  /** Добавить дежурного. */
  def add(chatId: ChatId, newEmployers: Set[Employer]): F[Unit]

  /** Удалить дежурного. */
  def remove(chatId: ChatId, item: Employer): F[Unit]

  /** Список всех дежурных. */
  def employers(chatId: ChatId): F[Set[Employer]]

  /** Установить количество дежурных. */
  def setDutyCount(chatId: ChatId, count: Count): F[Unit]

  /** Сбросить все настройки. */
  def reset(chatId: ChatId): F[Unit]

  /** Получить дежурных. */
  def duty(chatId: ChatId): F[Set[Employer]]

  /** Получить историю назначенных дежурных. */
  def history(chatId: ChatId): F[List[(Day, Set[Employer])]]
}
