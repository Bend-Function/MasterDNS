import { Body, Controller, Header, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import { exchangeRequestSchema, heartbeatRequestSchema, leaseRequestSchema, resultBatchSchema } from "@masterdns/contracts";
import { AllowNonBrowser, Public } from "../../auth/auth.decorators.js";
import { ProbeAgentAuth } from "./probe-agent-auth.js";
import { ProbeLeasesService } from "./probe-leases.service.js";
import { ProbeResultsService } from "./probe-results.service.js";
import { ProbesService } from "./probes.service.js";

@Public()
@AllowNonBrowser()
@Controller("v1/probe-agent")
export class ProbeAgentController {
  constructor(
    @Inject(ProbeAgentAuth) private readonly auth: ProbeAgentAuth,
    @Inject(ProbesService) private readonly probes: ProbesService,
    @Inject(ProbeLeasesService) private readonly leases: ProbeLeasesService,
    @Inject(ProbeResultsService) private readonly results: ProbeResultsService,
  ) {}
  @Post("exchange")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  exchange(@Body() body: unknown) {
    return this.auth.exchange(exchangeRequestSchema.parse(body).installToken);
  }
  @Post("heartbeat")
  @HttpCode(200)
  async heartbeat(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const identity = await this.auth.authenticate(authorization);
    return this.probes.heartbeat(identity.probeId, identity.tokenHash, heartbeatRequestSchema.parse(body));
  }
  @Post("tasks/lease")
  @HttpCode(200)
  async lease(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const identity = await this.auth.authenticate(authorization);
    const input = leaseRequestSchema.parse(body);
    const now = new Date();
    return { serverTime: now.toISOString(), tasks: await this.leases.lease(identity.probeId, input.capacity, now, identity.tokenHash), retryAfterMs: 1000 };
  }
  @Post("results")
  @HttpCode(200)
  async submit(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const identity = await this.auth.authenticate(authorization);
    const input = resultBatchSchema.parse(body);
    const results = [];
    // A batch is independently replayable per task. Recheck revocation and time for each write.
    for (const result of input.results) results.push({ taskId: result.taskId, status: await this.results.accept(identity.probeId, result, new Date(), identity.tokenHash) });
    return { results };
  }
}
