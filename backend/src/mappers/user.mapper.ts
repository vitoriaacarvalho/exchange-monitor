import type { UserModel } from '../generated/prisma/models.ts';

export type UserResponse = {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  createdAt: string;
};

/**
 * Built field by field. Spreading the row and deleting `passwordHash` would
 * leak every column added to the model afterwards, by default.
 */
export function toUserResponse(user: UserModel): UserResponse {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber,
    createdAt: user.createdAt.toISOString(),
  };
}
