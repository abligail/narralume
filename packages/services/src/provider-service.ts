import {
  type SqliteAssignmentRepository,
  type SqliteModelRepository,
  type SqliteProviderRepository,
} from "@narralume/persistence";

import { ServiceError } from "./service-error.js";

export class ProviderServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "ProviderServiceError";
  }
}

/** 停用 Provider 的引用完整性：仍有已分配模型时不能停用。 */
export function requireProviderDisablable(
  models: SqliteModelRepository,
  assignments: SqliteAssignmentRepository,
  providerId: string,
): void {
  const assignedModelIds = new Set(
    assignments.list().map((assignment) => assignment.modelId),
  );
  if (
    models
      .listByProvider(providerId)
      .some((model) => assignedModelIds.has(model.id))
  ) {
    throw new ProviderServiceError(
      "provider.assignment_in_use",
      "The provider still has assigned models and cannot be disabled",
      409,
    );
  }
}

/** 删除 Provider 的引用完整性：环境托管不能删、有模型或分配引用不能删。 */
export function requireProviderDeletable(
  providers: SqliteProviderRepository,
  models: SqliteModelRepository,
  assignments: SqliteAssignmentRepository,
  providerId: string,
  environmentManagedPrefix: string,
): void {
  if (providerId.startsWith(environmentManagedPrefix)) {
    throw new ProviderServiceError(
      "provider.environment_managed",
      "Environment-managed providers cannot be deleted; you can disable them instead",
      409,
    );
  }
  const provider = providers.get(providerId);
  if (!provider) {
    throw new ProviderServiceError(
      "provider.not_found",
      "Provider not found",
      404,
    );
  }
  const providerModels = models.listByProvider(providerId);
  const assignedModelIds = new Set(
    assignments.list().map((assignment) => assignment.modelId),
  );
  if (providerModels.some((model) => assignedModelIds.has(model.id))) {
    throw new ProviderServiceError(
      "provider.assignment_in_use",
      "Models under this provider are still referenced by model assignments; adjust the assignments first",
      409,
    );
  }
  if (providerModels.length > 0) {
    throw new ProviderServiceError(
      "provider.models_in_use",
      "The provider still has models; delete or move them first",
      409,
    );
  }
}
