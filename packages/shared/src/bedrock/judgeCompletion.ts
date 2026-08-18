/**
 * Bedrock implementation of the judge completion: identical to the Anthropic
 * one (a single FORCED tool call whose input schema is the judge's evaluation
 * schema), executed through the Bedrock Mantle client with Bedrock model ids.
 */

import type { JudgeCompletion } from "../judges.js";
import { createForcedToolJudgeCompletion } from "../anthropic/judgeCompletion.js";
import { bedrockModelId, createBedrockClient } from "./bedrockAgentRunner.js";

export function createBedrockJudgeCompletion(awsRegion?: string): JudgeCompletion {
  return createForcedToolJudgeCompletion(createBedrockClient(awsRegion), bedrockModelId);
}
