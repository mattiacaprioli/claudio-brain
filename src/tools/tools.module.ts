import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DockerStatusTool } from './docker-status.tool.js';
import { GitDiffTool } from './git-diff.tool.js';
import { HardwareTool } from './hardware.tool.js';
import { ToolCallsRepository } from './tool-calls.repository.js';
import { AGENT_TOOLS } from './tool.interface.js';
import { ToolsService } from './tools.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    GitDiffTool,
    DockerStatusTool,
    HardwareTool,

    // Il token AGENT_TOOLS raccoglie tutti gli strumenti in un array.
    // È l'unico punto da toccare per aggiungerne uno: `inject` cresce di una
    // riga e il registro (e quindi l'agente) lo vede automaticamente.
    {
      provide: AGENT_TOOLS,
      useFactory: (...tools: object[]) => tools,
      inject: [GitDiffTool, DockerStatusTool, HardwareTool],
    },

    ToolsService,
    ToolCallsRepository,
  ],
  exports: [ToolsService, ToolCallsRepository],
})
export class ToolsModule {}
