import { describe, expect, test } from 'bun:test';
import { parseOpenRouterModels } from './openrouter';

describe('OpenRouter catalogue', () => {
	test('keeps tool-capable models and useful pricing', () => {
		const models = parseOpenRouterModels([
			{
				id: 'openai/gpt-4.1-mini',
				name: 'OpenAI: GPT-4.1 Mini',
				context_length: 1_047_576,
				pricing: { prompt: '0.0000004', completion: '0.0000016' },
				supported_parameters: ['tools', 'temperature']
			},
			{
				id: 'image/only',
				name: 'No tools',
				supported_parameters: ['temperature']
			},
			{
				id: 'legacy/no-parameter-list',
				name: 'Legacy'
			}
		]);
		expect(models.map((model) => model.id)).toEqual([
			'legacy/no-parameter-list',
			'openai/gpt-4.1-mini'
		]);
		expect(models[1]).toMatchObject({
			contextLength: 1_047_576,
			promptPrice: 0.0000004,
			completionPrice: 0.0000016,
			supportsTools: true
		});
	});

	test('ignores malformed rows', () => {
		expect(parseOpenRouterModels(null)).toEqual([]);
		expect(parseOpenRouterModels([{ name: 'missing id' }, 'nope'])).toEqual([]);
	});
});
