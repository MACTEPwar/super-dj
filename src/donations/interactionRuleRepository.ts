import { PrismaClient, InteractionRule } from '@prisma/client';

export interface CreateInteractionRuleInput {
  userId: string;
  actionType: string;
  enabled: boolean;
  minAmount: number;
  commandKeyword: string;
}

export interface UpdateInteractionRuleInput {
  enabled?: boolean;
  minAmount?: number;
  commandKeyword?: string;
}

export class InteractionRuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByUser(userId: string): Promise<InteractionRule[]> {
    return this.prisma.interactionRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async listEnabledByUser(userId: string): Promise<InteractionRule[]> {
    return this.prisma.interactionRule.findMany({ where: { userId, enabled: true } });
  }

  async findById(id: string): Promise<InteractionRule | null> {
    return this.prisma.interactionRule.findUnique({ where: { id } });
  }

  async create(input: CreateInteractionRuleInput): Promise<InteractionRule> {
    return this.prisma.interactionRule.create({ data: input });
  }

  async update(id: string, input: UpdateInteractionRuleInput): Promise<InteractionRule> {
    return this.prisma.interactionRule.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.interactionRule.delete({ where: { id } });
  }
}
