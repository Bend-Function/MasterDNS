import { Global, Injectable, Module, type OnModuleDestroy } from "@nestjs/common";
import { createDatabase } from "@masterdns/db";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly connection = createDatabase();
  readonly db = this.connection.db;

  async onModuleDestroy() {
    await this.connection.close();
  }
}

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
