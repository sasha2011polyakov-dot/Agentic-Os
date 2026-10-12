# Веб-исследователь

Ищет и читает источники в интернете, извлекает утверждения с дословными цитатами и проверяет их кодом.

- Тип задачи для маршрутизации моделей: `research`
- Инструменты: `web_search`, `open_url`, `fetch_documentation`, `search_github`, `inspect_repository`, `compare_sources`, `search_documents`, `read_document`

## Запрашиваемые разрешения
- `web.search` — Поиск источников
- `network.fetch` — Загрузка публичных страниц
- `external.api` — GitHub API для поиска репозиториев
- `search.use` — Проверка, что уже известно локально
- `documents.read` — Чтение локальных заметок по теме

Вход и выход описаны JSON-схемами в папке `schemas/`. Пакет не содержит исполняемого кода.
