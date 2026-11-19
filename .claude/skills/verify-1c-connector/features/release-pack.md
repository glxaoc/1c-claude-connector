# Релизный пакет .mcpb

Пользователь скачивает `1c-connector.mcpb` из GitHub Releases и открывает двойным кликом.

Сборка: `npm run pack` = `clean-native` (удаляет `cpu-features`, `nan`, сборку ssh2 под одну ОС),
`mcpb validate manifest.json`, `mcpb pack . dist/1c-connector.mcpb`. Состав пакета задаёт
`.mcpbignore` (шаблоны от корня, `/tests/`, иначе выпадут одноимённые папки в `node_modules`).

Smoke (раздел 7) повторяет сборку на копии рабочего дерева с приманками локальных секретов и
проверяет состав пакета и запуск сервера из распакованного `.mcpb`. Сам `npm run pack` в рабочей
папке не запускается: он чистит `node_modules`.

Перед выпуском версии (README, раздел для разработчиков): поднять версию в `server/index.js`,
`manifest.json`, `package.json`, `package-lock.json` (smoke 1 сверяет все четыре), `verify.sh all`,
собрать `npm run pack`, установить в Claude Desktop руками, «проверь связь с 1С».
Публикацию релиза (`gh release create`) делает Иван.
