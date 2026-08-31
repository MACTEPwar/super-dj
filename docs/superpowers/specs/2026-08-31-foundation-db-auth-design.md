# Фундамент: БД + аутентификация — дизайн v1

Дата: 2026-08-31
Статус: утверждено, готово к декомпозиции на задачи

## 1. Контекст и скоуп

super-dj вырастает из одиночного бэкенд-сервиса (один RTMP-стрим, конфиг
через env, треки сканируются из статичной `AUDIO_DIR`) в мультипользовательскую
платформу. Согласованный порядок фаз (см. [[project-super-dj-roadmap]] в
памяти сессии):

1. Асинхронный ffprobe-багфикс — **сделано**, смёржено в `master`.
2. **Фундамент: БД + auth — эта спецификация.**
3. Мультитенантный бэкенд (плейлисты/треки в БД, привязка к пользователю).
4. YouTube Data API интеграция (start/stop управляют реальной трансляцией).
5. Веб-фронтенд.

Скоуп этой фазы — **только** `users`/`sessions`/auth-эндпоинты. Существующий
одно-пользовательский стриминговый код (`Library`, `PlaylistQueue`,
`StreamController`, весь `/stream/*` и `/library/*` API) **не трогается** —
он продолжает работать от `AUDIO_DIR`, как и раньше. Это осознанное решение:
не рисковать уже протестированным и реально работающим кодом ради фичи,
которая ему пока не нужна. Привязка плейлистов/треков к пользователю —
предмет фазы 3.

## 2. Технологический стек

- **БД:** PostgreSQL.
- **ORM:** Prisma (миграции, автогенерация типов).
- **Хэширование паролей:** `bcryptjs` (чистый JS, без нативной компиляции —
  не усложняет Docker-образ, в отличие от `bcrypt`).
- **Сессии:** таблица `Session` в той же Postgres (без Redis), `httpOnly`
  cookie с opaque-токеном. Без JWT — сознательный выбор ради простоты отзыва
  доступа (logout / смена пароля должны реально аннулировать сессию, а не
  ждать истечения токена).

## 3. Модель данных

```prisma
model User {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  createdAt    DateTime  @default(now())
  sessions     Session[]
}

model Session {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

`Session.id` — это же самое значение, что кладётся в cookie как токен.
UUID v4 даёт ~122 бита случайности — этого достаточно для opaque bearer
token, отдельный `crypto.randomBytes` не нужен.

Срок жизни сессии: **30 дней**, фиксированный (без sliding-renewal в MVP).

## 4. REST API

| Метод/путь | Действие |
|---|---|
| `POST /auth/register` `{email, password}` | Создать пользователя (409 при дубликате email), захэшировать пароль, создать сессию, поставить cookie |
| `POST /auth/login` `{email, password}` | Проверить пароль (401 при неверных данных), создать сессию, поставить cookie |
| `POST /auth/logout` | Удалить сессию из БД, очистить cookie |
| `GET /auth/me` | Текущий пользователь по cookie (401 если не авторизован) |

`requireAuth` — Express middleware: читает cookie → ищет `Session` в БД,
проверяет `expiresAt > now()` → подгружает связанного `User` → кладёт в
`req.user`. Если сессия не найдена/истекла — 401. Этот middleware
используется только эндпоинтом `/auth/me` в этой фазе; фазы 3+ будут
защищать им playlist/destination-роуты.

Без email-верификации и восстановления пароля в этой версии (нужна была бы
инфраструктура отправки почты — вне скоупа MVP).

## 5. Обработка ошибок

- Дубликат email при регистрации → 409.
- Неверный email/пароль при логине → 401 (без уточнения, что именно неверно
  — не подсказывать существование email в системе).
- Отсутствующая/истёкшая/невалидная сессия → 401.
- Некорректное тело запроса (`email`/`password` не строки или пустые) → 400.
- Недоступность БД при старте сервиса → сервис не стартует (fail-fast через
  `prisma.$connect()`), аналогично отсутствию `RTMP_URL`/`STREAM_KEY`.

## 6. Тестирование

По уже устоявшемуся в проекте паттерну (реальный I/O инжектится и мокается
в юнит-тестах, а сам wrapper проверяется вручную/smoke-тестом):

- `UserRepository`/`SessionRepository` — тонкие обёртки над Prisma Client
  (create/findByEmail/findById для User; create/findValid/deleteById для
  Session). Не покрываются юнит-тестами против реальной БД в CI; корректность
  проверяется вручную через `docker compose up` с реальным Postgres.
- `AuthService` (register/login/logout, хэширование, проверка сессии) —
  полностью юнит-тестируется с этими репозиториями как инжектируемыми
  фейками, без реальной БД.
- `authMiddleware` — юнит-тестируется с фейковым `SessionRepository`.
- REST-слой (`authRoutes`) — тесты через supertest с замоканным `AuthService`,
  по образцу существующих `streamRoutes.test.ts`/`libraryRoutes.test.ts`.

## 7. Docker / деплой

- `docker-compose.yml` получает сервис `postgres:16-alpine` с volume для
  персистентности данных.
- `DATABASE_URL` — обязательная env-переменная (без дефолта).
- В Dockerfile: `npx prisma generate` на этапе сборки; миграции применяются
  отдельным шагом (`npx prisma migrate deploy`) при старте контейнера или
  вручную оператором — не автоматически на каждый `npm start`, чтобы не
  рисковать случайным применением миграций в неподходящий момент.

## 8. Структура проекта

```
prisma/
  schema.prisma
src/
  db/
    prismaClient.ts        # singleton PrismaClient
  auth/
    passwordHash.ts        # hash()/verify() через bcryptjs
    sessionCookie.ts        # имя/опции cookie, set/clear-хелперы
    userRepository.ts        # тонкая обёртка над Prisma
    sessionRepository.ts     # тонкая обёртка над Prisma
    authService.ts            # бизнес-логика register/login/logout
    authMiddleware.ts          # requireAuth
    authRoutes.ts                # POST /register, /login, /logout, GET /me
  config/env.ts                 # + DATABASE_URL, SESSION_TTL_DAYS (опционально)
  api/app.ts                     # монтирует authRoutes рядом с существующими роутами
test/                              # зеркалирует src/auth, src/db не тестируется юнит-тестами
docker-compose.yml                 # + сервис postgres
```

## Самопроверка

- Плейсхолдеров/TBD нет.
- Скоуп чётко ограничен от фаз 3-5 (плейлисты/YouTube API/фронт не
  затрагиваются).
- Существующий стриминговый функционал (фазы до этой) не изменяется —
  проверено: ни один файл из `src/stream`, `src/playlist`, `src/ffmpeg`,
  `src/api/streamRoutes.ts`, `src/api/libraryRoutes.ts` не упомянут в списке
  изменяемых файлов.
- Неоднозначность про "что при недоступности БД" разрешена явно (fail-fast).
