package pro.horoshilov.app.bot

import cats.effect.{Async, ContextShift}
import com.bot4s.telegram.cats.TelegramBot
import com.softwaremill.sttp.asynchttpclient.cats.AsyncHttpClientCatsBackend

abstract class DefaultBot[F[_]: Async : ContextShift](val token: String)
  extends TelegramBot(token, AsyncHttpClientCatsBackend())