import pg from "pg";
const admin = new pg.Client({ connectionString: "postgres://postgres@127.0.0.1:5433/postgres" });
await admin.connect();
await admin.query("drop database if exists revessent with (force)");
await admin.query("create database revessent owner revessent_owner");
await admin.end();
console.log("DB recreated empty");
