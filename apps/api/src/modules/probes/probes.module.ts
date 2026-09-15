import { HealthPoliciesController } from "./health-policies.controller.js";
import { HealthPoliciesService } from "./health-policies.service.js";
import { Module } from "@nestjs/common";
import { ProbeAgentAuth } from "./probe-agent-auth.js";
import { ProbeAgentController } from "./probe-agent.controller.js";
import { ProbeLeasesService } from "./probe-leases.service.js";
import { ProbeResultsService } from "./probe-results.service.js";
import { ProbeRoundsService } from "./probe-rounds.service.js";
import { ProbesController } from "./probes.controller.js";
import { ProbesService } from "./probes.service.js";

@Module({
  controllers: [HealthPoliciesController, ProbesController, ProbeAgentController],
  providers: [HealthPoliciesService, ProbesService, ProbeAgentAuth, ProbeLeasesService, ProbeResultsService, ProbeRoundsService],
  exports: [ProbeRoundsService, ProbeLeasesService, ProbeResultsService],
})
export class ProbesModule {}
