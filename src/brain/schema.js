'use strict';
/*
 * The shape every model plan must have.
 *
 * Ollama uses this to constrain decoding, so the local model literally cannot
 * produce a tool name that is not in the registry, or a step that leaves out a
 * required argument. The validator still checks everything afterwards - the
 * schema keeps the shape right, the validator keeps the content safe.
 */
const tools = require('../agent/tools');

/* One schema branch per tool, each with that tool's own required arguments.
 * A single shared "args" object with every field optional lets a small model
 * close the object early - files.write with no content - and the decoder
 * cannot stop it. With a branch per tool, once the model has chosen
 * files.write the grammar will not let it finish without a file and content. */
function stepSchema(tool) {
  const props = {};
  for (const [key, spec] of Object.entries(tool.input.properties || {})) {
    props[key] = spec.enum
      ? { type: 'string', enum: spec.enum }
      : { type: spec.type === 'number' ? 'number' : 'string' };
  }
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tool: { type: 'string', enum: [tool.name] },
      args: {
        type: 'object',
        properties: props,
        required: tool.input.required || [],
        additionalProperties: false
      },
      dependsOn: { type: 'array', items: { type: 'string' } }
    },
    required: ['id', 'tool', 'args', 'dependsOn'],
    additionalProperties: false
  };
}

function planSchema() {
  return {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['answer', 'command', 'multi_step_task', 'clarify', 'refuse']
      },
      reply: { type: 'string' },
      goal: { type: 'string' },
      steps: {
        type: 'array',
        items: { anyOf: tools.offered().map(stepSchema) }
      }
    },
    required: ['intent', 'reply', 'goal', 'steps'],
    additionalProperties: false
  };
}

module.exports = { planSchema };
