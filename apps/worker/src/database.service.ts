import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createDatabase } from "@masterdns/db";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly connection = createDatabase();
  readonly db = this.connection.db;
  async onModuleDestroy() { await this.connection.close(); }
}
