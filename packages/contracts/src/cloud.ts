export type AddressFamily = 4 | 6;

export type CloudRef = {
  accountId: string;
  service: "ec2" | "lightsail";
  region: string;
  instanceId: string;
};

export type SlotRef = CloudRef & {
  slotId: string;
  interfaceId: string;
  family: AddressFamily;
};
