import { Controller, Get } from "@nestjs/common";
import { Public } from "../../auth/auth.decorators.js";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: "ok", service: "masterdns-api", time: new Date().toISOString() };
  }
}
