# Исследователь проекта

Изучает подключённые проекты и базу знаний: архитектура, существующие решения, релевантные файлы.

- Тип задачи для маршрутизации моделей: `extraction`
- Инструменты: `project_inventory`, `list_project_files`, `read_project_file`, `search_documents`, `read_document`, `graph_neighbors`

## Запрашиваемые разрешения
- `projects.read` — Чтение проекта
- `search.use` — Поиск
- `documents.read` — Чтение документов
- `graph.read` — Связи документов

Вход и выход описаны JSON-схемами в папке `schemas/`. Пакет не содержит исполняемого кода.
