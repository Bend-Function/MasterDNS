import { createDatabase } from "./index.js";
import { findDomainBindingConflicts, formatDomainBindingConflicts } from "./preflight.js";

const database = createDatabase();
try {
  const conflicts = await findDomainBindingConflicts(database.client);
  const report = formatDomainBindingConflicts(conflicts);
  if (conflicts.length === 0) {
    console.info(report);
  } else {
    console.error(report);
    process.exitCode = 1;
  }
} finally {
  await database.close();
}
