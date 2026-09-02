import { Prisma, PrismaClient, StreamTemplate } from '@prisma/client';
import { TemplateElement } from './templateTypes';

// TemplateElement's discriminated-union shape is fully JSON-compatible, but structurally
// doesn't satisfy Prisma's InputJsonValue (which requires an index signature) — this cast is
// the standard escape hatch Prisma itself documents for typed JSON columns.
function toJson(elements: TemplateElement[]): Prisma.InputJsonValue {
  return elements as unknown as Prisma.InputJsonValue;
}

export class TemplateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: { userId: string; name: string; elements: TemplateElement[] }): Promise<StreamTemplate> {
    return this.prisma.streamTemplate.create({
      data: { userId: data.userId, name: data.name, elements: toJson(data.elements) },
    });
  }

  listByUser(userId: string): Promise<StreamTemplate[]> {
    return this.prisma.streamTemplate.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  findById(id: string): Promise<StreamTemplate | null> {
    return this.prisma.streamTemplate.findUnique({ where: { id } });
  }

  update(id: string, data: { name?: string; elements?: TemplateElement[] }): Promise<StreamTemplate> {
    return this.prisma.streamTemplate.update({
      where: { id },
      data: { name: data.name, elements: data.elements ? toJson(data.elements) : undefined },
    });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.streamTemplate.deleteMany({ where: { id } });
  }
}
