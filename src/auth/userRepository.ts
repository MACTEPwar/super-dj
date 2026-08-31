import { PrismaClient, User, Prisma } from '@prisma/client';
import { ApiError } from '../errors';

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(email: string, passwordHash: string): Promise<User> {
    try {
      return await this.prisma.user.create({ data: { email, passwordHash } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(409, 'email is already registered');
      }
      throw err;
    }
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
