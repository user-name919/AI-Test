import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getRuntimePaths } from '../config/paths'
import { migrateDatabase } from './migrations'

const databasePath = getRuntimePaths().databasePath
mkdirSync(dirname(databasePath), { recursive: true })
export const database = new DatabaseSync(databasePath)
migrateDatabase(database)
