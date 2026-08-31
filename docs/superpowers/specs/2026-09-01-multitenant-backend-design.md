# Мультитенантный бэкенд — дизайн v1

Дата: 2026-09-01
Статус: утверждено, готово к декомпозиции на задачи

## 1. Контекст и скоуп

Фаза 3 из [[project-super-dj-roadmap]]. До этой фазы стриминг был одно-пользовательским:
один глобальный `StreamController`, треки сканируются из статичной `AUDIO_DIR`,
RTMP-креды — из env, `/stream/*` и `/library/*` без авторизации. Auth/БД (фаза 2)
уже добавлены, но не подключены к стриминговому коду.

Эта фаза переводит стриминг на мультипользовательскую модель:
- Треки и плейлисты — в БД, привязаны к пользователю, загружаются через API
  (не сканирование папки).
- Ключи вещания (RTMP URL + stream key) — в БД, зашифрованы, привязаны к
  пользователю через сущность `StreamDestination`.
- **Несколько параллельных стримов одновременно — по одному на каждое
  подключённое назначение (`StreamDestination`), а не один на пользователя.**
  Это осознанный задел под будущую мульти-платформенность (YouTube + другие
  сервисы одновременно) — ключ раннтайм-реестра стримов — `destinationId`,
  а не `userId`.
- Старый одно-пользовательский путь (`Library`, `AUDIO_DIR`, `/library/*`,
  безавторизационный глобальный `/stream/*`) **удаляется полностью**, не
  сохраняется параллельно.

Вне скоупа этой фазы (сознательно не делаем сейчас):
- Реальная интеграция с YouTube Data API (создание/завершение трансляции
  через API площадки) — фаза 4.
- Лимит на количество одновременных активных стримов на сервере — отложено
  по явной просьбе, обдумать позже.
- Персональный фон экрана (Now Playing background) на пользователя — остаётся
  один глобальный ассет, как и раньше; кастомизация фона — часть будущего
  "конструктора обложек", уже вынесенного за скоуп ранее.
- Изменение уже запущенного стрима "на лету" при редактировании плейлиста —
  плейлист берётся снимком на момент `/start`; правки применяются только
  к следующему `/start`.
- Гранулярные операции над плейлистом (вставить/удалить один трек) — только
  полная замена упорядоченного списка через один эндпоинт.

## 2. Модель данных (добавления к Prisma-схеме из фазы 2)

```prisma
model Track {
  id              String   @id @default(uuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name            String
  audioPath       String
  coverPath       String?
  durationSeconds Float?
  createdAt       DateTime @default(now())
  playlistTracks  PlaylistTrack[]
}

model Playlist {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name      String
  createdAt DateTime @default(now())
  tracks    PlaylistTrack[]
}

model PlaylistTrack {
  id         String   @id @default(uuid())
  playlistId String
  playlist   Playlist @relation(fields: [playlistId], references: [id], onDelete: Cascade)
  trackId    String
  track      Track    @relation(fields: [trackId], references: [id], onDelete: Cascade)
  position   Int
}

model StreamDestination {
  id                 String   @id @default(uuid())
  userId             String
  user               User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  rtmpUrl            String
  streamKeyEncrypted String
  provider           String   @default("youtube")
  createdAt          DateTime @default(now())
}
```

`User` (уже существует с фазы 2) получает обратные связи: `tracks`, `playlists`,
`streamDestinations`.

Длительность трека (`durationSeconds`) вычисляется один раз через `ffprobe`
**при загрузке файла** и кэшируется в БД — не пересчитывается на каждый
`/stream/start`. Это заодно устраняет источник задержек, который уже
исправлялся в отдельном багфиксе для одно-пользовательской версии
(`getAudioDurationSeconds` там был сделан асинхронным; кэширование здесь —
дополнительная оптимизация, применимая только к новому per-user пути).

## 3. Загрузка файлов

- `POST /tracks`, `multipart/form-data`: поле `audio` (обязательно,
  `.mp3`/`.wav`/`.flac`/`.m4a`, лимит 50MB), `cover` (опционально,
  `.jpg`/`.jpeg`/`.png`, лимит 10MB), `name` (опционально, иначе берётся
  из имени файла без расширения). Через `multer`.
- Хранение на диске: `<UPLOADS_DIR>/<userId>/<trackId>/audio.<ext>` и
  `.../cover.<ext>`. Новая обязательная env-переменная `UPLOADS_DIR`
  (аналог прежнего `AUDIO_DIR`, но директория только для записи через API,
  не сканируется).
- При удалении трека (`DELETE /tracks/:id`) — удаляются файлы с диска и
  строка из БД (каскадно удаляются связанные `PlaylistTrack`, сами
  плейлисты не удаляются).

## 4. Шифрование ключей вещания

- Новая обязательная env-переменная `STREAM_KEY_ENCRYPTION_KEY` (32 байта,
  base64 или hex — формат фиксируется в реализации).
- `src/crypto/streamKeyCipher.ts`: `encrypt(plaintext: string): string`,
  `decrypt(encrypted: string): string`, AES-256-GCM (IV + authTag + ciphertext,
  упакованные в одну base64-строку).
- `streamKeyEncrypted` в БД — только зашифрованное значение. API никогда не
  возвращает расшифрованный ключ в ответах (`GET /destinations` отдаёт только
  `id`/`name`/`rtmpUrl`/`provider`, без ключа).

## 5. Мульти-стриминг: `StreamManager`

- `StreamManager` — реестр в памяти процесса: `Map<destinationId, StreamController>`.
- `POST /destinations/:destinationId/stream/start` `{playlistId}`:
  - Проверяет владение (`destination.userId === req.user.id`), иначе 403.
  - Если для этого `destinationId` уже есть активный/на паузе контроллер — 409
    (как и раньше на уровне одного `StreamController`).
  - **Всегда создаёт новый `StreamController`**, беря снимок плейлиста из БД
    (`PlaylistTrack`, отсортированные по `position`) и расшифрованные RTMP-креды
    назначения — заменяя предыдущий остановленный инстанс в реестре для этого
    `destinationId`. Не пытаемся на лету менять плейлист/креды у уже
    работающего инстанса — это упрощение осознанно.
  - `fifoPath` строится по `destinationId` (не по `userId`), чтобы параллельные
    стримы разных назначений одного пользователя не конфликтовали.
- Остальные действия (`stop`/`pause`/`resume`/`next`/`previous`/`play`/`status`)
  ищут контроллер в реестре по `destinationId` (с проверкой владения):
  если записи нет — `status` возвращает синтетический `{state:'idle',
  currentTrack:null,nextTrack:null}`, остальные действия — 409, как если бы
  `StreamController` был в состоянии `idle`.
- `POST .../stream/play` `{name}` ищет трек по имени среди **всех треков
  пользователя** (`Track.userId`), не только тех, что в текущем плейлисте —
  сохраняет поведение из одно-пользовательской версии (`Library.findByName`),
  просто на БД вместо скана диска.

## 6. REST API

Все новые эндпоинты — под `requireAuth` (фаза 2).

| Метод/путь | Действие |
|---|---|
| `POST /tracks` | Загрузить трек (multipart) |
| `GET /tracks` | Список треков текущего пользователя |
| `DELETE /tracks/:id` | Удалить трек (файлы + БД) |
| `POST /playlists` `{name}` | Создать плейлист |
| `GET /playlists` | Список плейлистов пользователя |
| `GET /playlists/:id` | Плейлист с упорядоченными треками |
| `PUT /playlists/:id/tracks` `{trackIds: string[]}` | Полная замена упорядоченного списка треков |
| `DELETE /playlists/:id` | Удалить плейлист (треки не удаляются) |
| `POST /destinations` `{name, rtmpUrl, streamKey}` | Создать назначение (ключ шифруется) |
| `GET /destinations` | Список назначений (без ключа) |
| `DELETE /destinations/:id` | Удалить назначение (останавливает активный стрим, если есть) |
| `POST /destinations/:id/stream/{start,stop,pause,resume,next,previous,play}` | Управление стримом этого назначения |
| `GET /destinations/:id/stream/status` | Статус стрима этого назначения |

Полностью удаляется: `Library` (`src/playlist/library.ts`), `/library/*`,
`AUDIO_DIR`, старый безавторизационный глобальный `/stream/*` и его роуты
(`src/api/streamRoutes.ts` в текущем виде).

## 7. Обработка ошибок

- Загрузка файла неверного формата/превышающего лимит → 400.
- Действие над чужим `destinationId`/`playlistId`/`trackId` → 403 (не 404 —
  не даём различить "не существует" от "не моё" для чужих ID, единообразно
  с общим подходом "не раскрывать больше, чем нужно").
- Действие над несуществующим `destinationId`/`playlistId`/`trackId` → 404.
- `/stream/start` на назначение с уже активным стримом → 409.
- `/stream/{pause,resume,next,previous,play}` без активного стрима у
  назначения → 409.
- `playlistId` в `/stream/start` без единого трека → 409 (плейлист пуст).

## 8. Тестирование

По устоявшемуся в проекте паттерну:
- `TrackRepository`, `PlaylistRepository`, `DestinationRepository` — тонкие
  обёртки над Prisma, **без юнит-тестов** (как `UserRepository`/`SessionRepository`
  в фазе 2) — корректность проверяется вручную через smoke-test с реальным
  Postgres.
- Бизнес-логика (обработка загрузки, сборка снимка плейлиста для
  `StreamController`, `StreamManager` с реестром по `destinationId`,
  шифрование/расшифровка) — юнит-тестируется с фейковыми репозиториями,
  как `AuthService` в фазе 2.
- `streamKeyCipher` — юнит-тестируется напрямую (реальное шифрование/
  расшифровка, round-trip), как `passwordHash` в фазе 2 (bcryptjs).
- REST-слой — через supertest с замоканными сервисами, по образцу
  существующих `authRoutes.test.ts`.
- Ручной smoke-test через `docker compose up`: загрузить трек, создать
  плейлист, создать назначение, запустить стрим, проверить `/status`,
  остановить — до реального ffmpeg/YouTube это не подключает (RTMP по-прежнему
  просто ffmpeg-push, без Data API), но проверяет весь новый DB-путь целиком.

## 9. Docker / инфраструктура

- Новые обязательные env: `UPLOADS_DIR` (например `/data/uploads`),
  `STREAM_KEY_ENCRYPTION_KEY`.
- `docker-compose.yml`: volume для `UPLOADS_DIR` (персистентность
  загруженных файлов между рестартами контейнера).
- Новая Prisma-миграция для `Track`/`Playlist`/`PlaylistTrack`/`StreamDestination`
  — генерируется тем же способом, что и миграция фазы 2 (временные Docker-
  контейнеры на тестовом хосте, т.к. локального Docker-демона нет).

## Самопроверка

- Плейлисты/треки/назначения полностью привязаны к пользователю везде, где
  это нужно (владение проверяется на каждом действии).
- Скоуп чётко ограничен от фазы 4 (реальный YouTube API) — здесь только
  структура данных и RTMP-push, как и раньше.
- Неоднозначность "что если правят плейлист во время стрима" разрешена явно
  (снимок на момент `/start`, без live-обновления).
- Ключевое архитектурное решение (реестр по `destinationId`, не `userId`)
  зафиксировано с явным обоснованием — по прямому запросу пользователя учесть
  будущую мульти-платформенность без переделки.
