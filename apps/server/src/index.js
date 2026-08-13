import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./database.js";

const config = readConfig();
const database = openDatabase(config.databasePath);
const server = createApp({ database, config });

server.listen(config.port, "0.0.0.0", () => {
  console.log(`who-said-dis listening on ${config.publicUrl}`);
});

function shutdown() {
  server.roomEvents.close();
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
