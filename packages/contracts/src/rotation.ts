export type CloudStep = {
  id: string;
  action: string;
  resourceKey: string;
  arguments: Record<string, unknown>;
  destructive: boolean;
};
