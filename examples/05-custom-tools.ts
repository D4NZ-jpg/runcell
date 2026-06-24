import { createAgent, type ToolDefinition } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const customerSchema = z.object({
  customerName: z.string(),
  accountStatus: z.string(),
  answer: z.string(),
});

const lookupCustomerSchema = z.object({ id: z.string() });
type LookupCustomerInput = z.infer<typeof lookupCustomerSchema>;

export async function answerWithHostTool(
  customerId = 'cus_123',
): Promise<z.infer<typeof customerSchema>> {
  const lookupCustomer = {
    description: 'Look up customer account details by customer id.',
    schema: lookupCustomerSchema,
    execute: ({ id }: LookupCustomerInput) => ({
      id,
      name: id === customerId ? 'Acme Inc.' : 'Unknown customer',
      accountStatus: 'active',
    }),
  } satisfies ToolDefinition<typeof lookupCustomerSchema>;

  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    tools: { lookupCustomer },
  });

  const result = await agent.run({
    prompt: `Use lookupCustomer for ${customerId}, then summarize the account.`,
    schema: customerSchema,
  });

  return result.data;
}

runExample(import.meta.url, () => answerWithHostTool());
