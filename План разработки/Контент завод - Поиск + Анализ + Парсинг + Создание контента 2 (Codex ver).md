# Парсинг контента — стек и инструменты 2 (Codex ver)

> Дата: 2026-07-01  
> Версия: Codex research / уточнение стека для парсинга текста, сайтов, соцсетей и видео  
> Статус: проектное предложение для внесения в архитектуру Intelligence Agent

---

## 1. Главная идея

Для агента онлайн-разведчика не нужен один универсальный "парсер всего". Правильнее строить каскадную систему:

```text
Сначала дешево достаем готовые данные
        ↓
Если данных не хватает — транскрибируем аудио
        ↓
Если смысл передается визуалом — анализируем кадры и сцены
        ↓
Объединяем аудио + визуал + OCR + метаданные
        ↓
LLM делает смысловой разбор и отчет
```

Так агент будет:

- дешевле в работе;
- устойчивее к сбоям;
- точнее при анализе видео;
- гибче при добавлении новых источников;
- совместим с будущей MCP-архитектурой и Tool Registry.

---

## 2. Рекомендуемый стек по слоям

### 2.1 Сбор текстового контента

| Задача | Основной инструмент | Резерв / альтернатива | Комментарий |
|---|---|---|---|
| Парсинг сайтов, статей, блогов | Firecrawl | Jina Reader, Playwright, Spider.cloud | Firecrawl лучше всего подходит для LLM-ready markdown/JSON |
| Парсинг динамических сайтов | Playwright | Firecrawl Interact, Browserless | Нужен, если сайт требует кликов, скролла, авторизации |
| RSS / новости | RSS adapters | Feedly API, Google News via approved APIs | Самый дешевый источник новостных сигналов |
| PDF / документы | Firecrawl / PyMuPDF | Unstructured, LlamaParse | Нужен для отчетов, презентаций, PDF-материалов |
| OCR текста с картинок | Tesseract / PaddleOCR | Google Vision OCR | Для скриншотов, слайдов, мемов, интерфейсов |

### 2.2 Сбор соцсетей и видео-метаданных

| Задача | Основной инструмент | Резерв / альтернатива | Комментарий |
|---|---|---|---|
| YouTube metadata | YouTube Data API | Apify YouTube Scraper | Официальный путь для названия, описания, статистики, поиска |
| YouTube search/trends | YouTube Data API + Apify | сторонние API только после проверки | YouTube API имеет квоты, Apify удобнее для пакетного сбора |
| YouTube subtitles | YouTube captions для своих видео / Apify actor | Whisper / Deepgram | Официальный `captions.download` ограничен правами владельца видео |
| TikTok | Apify TikTok Scraper | Bright Data, сторонние API | Для трендов, хэштегов, метрик, видео |
| VK / Telegram | Apify / Telethon / VK API | кастомные MCP-серверы | Telegram лучше через публичные каналы и разрешенные API |
| Комментарии и реакции | Apify / platform API | отдельные адаптеры | Нужны для оценки виральности и боли аудитории |

### 2.3 Работа с локальными видеофайлами

| Задача | Инструмент | Комментарий |
|---|---|---|
| Извлечь аудио | FFmpeg | Базовый инструмент для `.mp4`, `.mov`, `.webm`, `.mkv` |
| Нарезать видео на сцены | PySceneDetect | Находит смену сцен и помогает не слать всю запись в LLM |
| Извлечь ключевые кадры | FFmpeg / OpenCV | Кадры идут в vision-модель |
| Получить технические метаданные | FFprobe | Длительность, кодеки, FPS, дорожки |
| Нарезать длинные видео | FFmpeg | Нужен chunking по 5-10 минут или по сценам |

---

## 3. Транскрибация аудио

### 3.1 Приоритеты по стоимости

```text
1. Уже готовые субтитры / transcript
2. YouTube captions, если есть право доступа
3. Self-hosted Whisper / faster-whisper
4. Deepgram
5. OpenAI Speech-to-Text / Whisper API
6. AssemblyAI
```

### 3.2 Выбор STT-инструментов

| Инструмент | Когда использовать | Плюсы | Минусы |
|---|---|---|---|
| Готовые субтитры YouTube | Если доступны легально и технически | Почти бесплатно, быстро | Не всегда доступны, могут быть неточными |
| Self-hosted Whisper / faster-whisper | Если есть GPU или пакетная обработка | Дешево при больших объемах | Нужно поддерживать инфраструктуру |
| Deepgram | Когда нужен дешевый API и скорость | Хорошая цена, масштабируемость | Некоторые фичи могут оплачиваться отдельно |
| OpenAI `gpt-4o-mini-transcribe` / Whisper | Когда нужна простая интеграция | Хорошее качество, удобно | Дороже self-hosted |
| AssemblyAI | Когда нужны speech intelligence функции | Диаризация, понимание речи, удобные API | Обычно дороже простых STT-вариантов |

### 3.3 Что хранить после транскрибации

```json
{
  "video_id": "source-video-id",
  "source_url": "https://...",
  "language": "ru",
  "segments": [
    {
      "start": 12.4,
      "end": 18.9,
      "speaker": "speaker_1",
      "text": "Здесь мы видим рост показателя..."
    }
  ],
  "provider": "whisper|deepgram|assemblyai|youtube_captions",
  "confidence": 0.91
}
```

---

## 4. Понимание видео без звука

Обычный транскрибатор понимает только речь. Если смысл передается визуально, например через график, демонстрацию экрана, таблицу, жест, мем, слайд или видеоряд без объяснения, нужен отдельный слой видео-понимания.

Правильная архитектура:

```text
Видео
 ├── Аудио → STT → транскрипт с таймкодами
 ├── Кадры → vision model → описание визуала с таймкодами
 ├── OCR → текст на экране, слайды, таблицы, интерфейсы
 ├── Сцены → shot/scene detection
 └── Метаданные → название, описание, канал, просмотры, реакции
        ↓
Timeline Merger
        ↓
LLM-анализ полного смысла
```

### 4.1 Инструменты для визуального понимания видео

| Инструмент | Роль | Когда использовать |
|---|---|---|
| Gemini Video Understanding | Мультимодальный анализ видео | Хороший основной вариант для видео как файла |
| TwelveLabs | Специализированная video understanding платформа | Когда нужно глубоко искать объекты, действия, речь, текст |
| Google Video Intelligence | Labels, objects, shots, OCR, explicit, person/face/logo detection | Когда нужны структурные аннотации и таймкоды |
| OpenAI Vision через кадры | Анализ выбранных кадров + transcript | Когда нужно контролировать стоимость и отправлять только важные кадры |
| OCR: Tesseract/PaddleOCR/Google Vision | Текст на экране | Слайды, интерфейсы, таблицы, субтитры, мемы |

### 4.2 Как объединять голос и визуал

Пример:

```text
00:20-00:35
Аудио: "Вот здесь видно, где начался рост."
Визуал: на экране график BTC, зеленая свеча, курсор указывает точку входа, подпись +18%.
OCR: "BTC/USDT", "+18%", "Entry".
Вывод агента: автор показывает точку входа на криптографике и связывает рост с конкретным сигналом.
```

Итоговая структура для анализа:

```json
{
  "start": 20.0,
  "end": 35.0,
  "audio_meaning": "Автор говорит о начале роста",
  "visual_meaning": "На экране график BTC с выделенной точкой входа",
  "ocr_text": ["BTC/USDT", "+18%", "Entry"],
  "combined_meaning": "Демонстрация торгового сигнала и результата роста",
  "content_hooks": ["показывает результат на графике", "использует визуальное доказательство"]
}
```

---

## 5. Каскад обработки видео

### 5.1 Дешевый режим

Используется для массового мониторинга.

```text
1. Получить metadata: title, description, views, likes, comments
2. Проверить наличие captions/subtitles
3. Если captions есть — использовать их
4. Если captions нет — STT через дешевую модель
5. Извлечь 1 кадр на сцену или 1 кадр каждые 10-20 секунд
6. Vision-анализ только для топовых роликов
7. Итоговый LLM-анализ
```

Плюсы:

- низкая стоимость;
- подходит для ежедневного мониторинга;
- можно обрабатывать много видео.

Минусы:

- может пропустить мелкие визуальные детали;
- не всегда точно понимает быстрые монтажные ролики.

### 5.2 Стандартный режим

Используется для отчетов нормального качества.

```text
1. Metadata + comments + engagement
2. Audio transcription with timestamps
3. Scene detection
4. Keyframes per scene
5. OCR по ключевым кадрам
6. Vision-анализ важных сцен
7. Timeline merge
8. LLM-анализ: смысл, хук, триггер, оффер, причина виральности
```

### 5.3 Глубокий режим

Используется для важных видео, конкурентов, обучающих материалов, рекламных креативов.

```text
1. Полная транскрибация
2. Диаризация спикеров
3. Scene detection + shot detection
4. Частый sampling кадров
5. OCR всех важных экранов
6. Мультимодальная модель: Gemini / TwelveLabs
7. Отдельный анализ:
   - смысл
   - визуальная подача
   - монтаж
   - эмоции
   - хук первых секунд
   - оффер
   - удержание внимания
   - что можно адаптировать
```

---

## 6. Рекомендуемая агентная архитектура

Имеет смысл разделить парсинг и создание контента на разных агентов.

```text
Главный оркестратор
        ↓
┌──────────────────────────────┐
│ Агент разведки / парсинга     │
│ - web parser                  │
│ - social parser               │
│ - video parser                │
│ - transcript agent            │
│ - visual understanding agent  │
└──────────────────────────────┘
        ↓
┌──────────────────────────────┐
│ Агент анализа                 │
│ - скоринг                     │
│ - дедупликация                │
│ - фактчекинг                  │
│ - объяснение трендов          │
└──────────────────────────────┘
        ↓
┌──────────────────────────────┐
│ Агент создания контента       │
│ - идеи постов                 │
│ - сценарии Reels/TikTok       │
│ - адаптация под платформу     │
│ - генерация изображений       │
│ - генерация видео             │
└──────────────────────────────┘
```

### Почему лучше разделять

- У парсинга и генерации разные задачи.
- Разные инструменты и разные бюджеты.
- Парсер должен быть надежным и проверяющим.
- Контент-агент должен быть креативным и производящим.
- Оркестратор может вызывать только нужного агента под конкретную команду пользователя.

### MVP-вариант

Для первой версии достаточно:

```text
1. Orchestrator
2. Research / Parsing Agent
3. Video Understanding Agent
4. Report / Analysis Agent
```

Агент создания контента лучше добавить после того, как разведка начнет стабильно давать хорошие отчеты.

---

## 7. Tool Registry — предлагаемые записи

```yaml
tools:
  - id: firecrawl-main
    name: Firecrawl
    role: web_scraping
    capabilities:
      - scrape_web_page
      - crawl_site
      - extract_markdown
      - extract_structured_json
    priority: 1
    fallback:
      - jina-reader
      - playwright-browser

  - id: apify-youtube
    name: Apify YouTube Scraper
    role: youtube_social_scraping
    capabilities:
      - scrape_youtube_metadata
      - scrape_youtube_search
      - scrape_youtube_comments
      - scrape_subtitles_if_available
    priority: 1
    fallback:
      - youtube-data-api

  - id: youtube-data-api
    name: YouTube Data API
    role: official_youtube_metadata
    capabilities:
      - search_videos
      - get_video_metadata
      - filter_by_caption_availability
      - manage_own_captions
    priority: 1
    limitations:
      - captions_download_requires_owner_permission
      - quota_limited

  - id: ffmpeg-local
    name: FFmpeg
    role: local_video_processing
    capabilities:
      - extract_audio
      - extract_frames
      - cut_video
      - convert_formats
      - inspect_metadata
    priority: 1

  - id: pyscenedetect
    name: PySceneDetect
    role: scene_detection
    capabilities:
      - detect_scenes
      - split_video_by_scenes
      - generate_scene_timecodes
    priority: 1

  - id: deepgram-stt
    name: Deepgram
    role: speech_to_text
    capabilities:
      - transcribe_audio
      - detect_language
      - diarization
      - smart_formatting
    priority: 1
    fallback:
      - openai-whisper
      - assemblyai

  - id: gemini-video
    name: Gemini Video Understanding
    role: multimodal_video_understanding
    capabilities:
      - analyze_video_file
      - describe_visual_scenes
      - combine_audio_visual_context
    priority: 1
    fallback:
      - twelvelabs
      - openai-vision-frames
      - google-video-intelligence

  - id: twelvelabs-video
    name: TwelveLabs
    role: video_understanding
    capabilities:
      - identify_objects_actions_speech_text
      - semantic_video_search
      - video_indexing
    priority: 2

  - id: openai-vision-frames
    name: OpenAI Vision over frames
    role: frame_visual_analysis
    capabilities:
      - analyze_keyframes
      - describe_visual_context
      - combine_with_transcript
    priority: 2
```

---

## 8. Формат результата парсинга видео

```json
{
  "task_id": "uuid",
  "source": {
    "type": "youtube|tiktok|local_file|url",
    "url": "https://...",
    "file_path": null,
    "platform_id": "video-id"
  },
  "metadata": {
    "title": "Название видео",
    "description": "Описание",
    "duration_sec": 842,
    "views": 120000,
    "likes": 5400,
    "comments": 380,
    "published_at": "2026-07-01T10:00:00Z"
  },
  "transcript": {
    "provider": "youtube_captions|deepgram|whisper|assemblyai",
    "segments": []
  },
  "visual_timeline": [
    {
      "start": 0,
      "end": 12,
      "scene_summary": "Автор показывает интерфейс сервиса",
      "ocr_text": ["Dashboard", "Revenue", "+23%"],
      "objects": ["laptop", "chart", "cursor"],
      "actions": ["screen demonstration"]
    }
  ],
  "combined_analysis": {
    "core_meaning": "Главный смысл видео",
    "hooks": [],
    "triggers": [],
    "offers": [],
    "viral_reasons": [],
    "content_ideas": []
  },
  "meta": {
    "tools_used": [],
    "cost_usd": 0.0,
    "duration_sec": 0,
    "quality_mode": "cheap|standard|deep"
  }
}
```

---

## 9. Важные ограничения

### YouTube

- Официальный YouTube Data API подходит для метаданных, поиска, статистики и работы с captions владельца видео.
- `captions.download` требует право редактировать видео и имеет отдельную quota cost.
- Автосубтитры чужих публичных видео не всегда доступны через официальный API.
- Неофициальные transcript/scraper-инструменты могут быть удобными, но их нужно использовать осторожно с учетом правил платформы, прав на контент и юридических рисков.

### Видео-анализ

- Полный анализ каждого кадра слишком дорогой.
- Нужно использовать scene detection и keyframe sampling.
- Для быстрых роликов sampling должен быть чаще.
- Для лекций и подкастов можно анализировать визуал реже.
- Если видео содержит слайды, интерфейсы или графики, OCR обязателен.

---

## 10. Рекомендация для MVP

Минимальный рабочий стек:

```text
Web:
  Firecrawl

Social / video discovery:
  Apify
  YouTube Data API

Local video processing:
  FFmpeg
  PySceneDetect

Speech-to-text:
  Deepgram или Whisper

Visual understanding:
  Gemini Video Understanding
  OpenAI Vision через keyframes как fallback

Analysis:
  OpenRouter → GPT / Claude / Gemini

Storage:
  Supabase
  Redis для кэша и очередей
```

Первый MVP-цикл:

```text
1. Пользователь отправляет ссылку на видео или тему
2. Агент получает metadata
3. Агент пытается получить transcript
4. Если transcript недоступен — делает STT
5. Агент извлекает ключевые кадры
6. Vision-модель описывает визуальные сцены
7. LLM объединяет голос + визуал
8. Агент выдает отчет:
   - о чем видео
   - что показано визуально
   - какие хуки и триггеры
   - почему видео может залететь
   - как адаптировать под контент-завод
```

---

## 11. Что добавить в существующие документы проекта

Позже эти решения стоит аккуратно разнести по основным файлам:

- `03. Брейншторм.md` — добавить как уточнение по видео-парсингу и мультимодальному анализу.
- `04. ТЗ.md` — добавить требования к анализу видео: аудио, визуал, OCR, timeline.
- `05. Архитектура.md` — добавить отдельный слой `Video Understanding Pipeline`.
- `06. Задачник.md` — добавить задачи по FFmpeg, PySceneDetect, Gemini/TwelveLabs, OCR.
- `08. Тестирование.md` — добавить тесты видео без звука, видео со слайдами, видео с визуальными действиями.

---

## 12. Источники и документация

- YouTube Data API Captions: https://developers.google.com/youtube/v3/docs/captions
- YouTube Captions download: https://developers.google.com/youtube/v3/docs/captions/download
- YouTube Search API: https://developers.google.com/youtube/v3/docs/search/list
- YouTube API quotas: https://developers.google.com/youtube/v3/determine_quota_cost
- YouTube API policies: https://developers.google.com/youtube/terms/developer-policies
- Firecrawl docs: https://docs.firecrawl.dev/api-reference/v2-introduction
- Apify YouTube Scraper: https://apify.com/streamers/youtube-scraper
- Gemini Video Understanding: https://ai.google.dev/gemini-api/docs/video-understanding
- Gemini API Pricing: https://ai.google.dev/gemini-api/docs/pricing
- OpenAI Speech-to-Text: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Vision: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI video understanding cookbook: https://developers.openai.com/cookbook/examples/gpt_with_vision_for_video_understanding
- TwelveLabs docs: https://docs.twelvelabs.io/docs/get-started/introduction
- Google Video Intelligence: https://docs.cloud.google.com/video-intelligence/docs/feature-label-detection
- Google Video Intelligence pricing: https://cloud.google.com/video-intelligence/pricing
- FFmpeg docs: https://ffmpeg.org/ffmpeg.html
- PySceneDetect docs: https://www.scenedetect.com/
