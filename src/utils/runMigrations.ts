// import { Sequelize } from "sequelize";
// import { Umzug, SequelizeStorage } from "umzug";
// import { dbConfig } from "../db/db.config";

// const sequelize = new Sequelize({
//   database: dbConfig.name,
//   username: dbConfig.user,
//   password: dbConfig.password,
//   host: dbConfig.host,
//   port: dbConfig.port,
//   dialect: "postgres",
//   logging: dbConfig.logging,
// });

// const umzug = new Umzug({
//   migrations: {
//     glob: "src/db/migrations/*.js",
//     resolve: ({ name, path, context }) => {
//       const migration = require(path!);
//       return {
//         name,
//         up: async () => migration.up(context.getQueryInterface(), Sequelize),
//         down: async () =>
//           migration.down(context.getQueryInterface(), Sequelize),
//       };
//     },
//   },
//   context: sequelize,
//   storage: new SequelizeStorage({ sequelize }),
//   logger: console,
// });

// (async () => {
//   try {
//     await umzug.up();
//     console.log("All migrations have been executed successfully.");
//     process.exit(0);
//   } catch (error) {
//     console.error("Error running migrations:", error);
//     process.exit(1);
//   }
// })();
