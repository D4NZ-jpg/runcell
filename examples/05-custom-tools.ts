import { createAgent, type ToolDefinition } from 'runcell';
import { z } from 'zod';

const customerSchema = z.object({
  customerName: z.string(),
  accountStatus: z.string(),
  answer: z.string(),
});

const lookupCustomerSchema = z.object({ id: z.string() });

export async function answerWithHostTool(
  customerId: string,
): Promise<z.infer<typeof customerSchema>> {
  const lookupCustomer = {
    description: 'Look up customer account details by customer id.',
    schema: lookupCustomerSchema,
    execute: ({ id }) => ({
      id,
      name: id === customerId ? 'Acme Inc.' : 'Unknown customer',
      accountStatus: 'active',
    }),
  } satisfies ToolDefinition<typeof lookupCustomerSchema>;

  const agent = createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    credentials: { type: 'env' },
    tools: { lookupCustomer },
  });

  const result = await agent.run({
    prompt: `Use lookupCustomer for ${customerId}, then summarize the account.`,
    schema: customerSchema,
  });

  return result.data;
}
