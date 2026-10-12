# Исполнитель

Выполняет шаг плана: готовит изменения файлов (наборы изменений), документы и запускает разрешённые проверки.

- Тип задачи для маршрутизации моделей: `generation`
- Инструменты: `read_document`, `read_project_file`, `list_project_files`, `search_documents`, `propose_file_change`, `create_document`, `run_check`

## Запрашиваемые разрешения
- `documents.read` — Чтение документов
- `projects.read` — Чтение кода
- `search.use` — Поиск
- `changes.propose` — Подготовка наборов изменений
- `documents.create` — Создание документов с результатами
- `commands.run` — Запуск проверок, заданных пользователем

Вход и выход описаны JSON-схемами в папке `schemas/`. Пакет не содержит исполняемого кода.
