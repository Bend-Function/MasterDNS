type AddressFamily = "4" | "6";
type EndpointWithAddresses = { addresses: Array<{ family: AddressFamily; state: string }> };

export function actualEndpointFamilies(endpoint: EndpointWithAddresses): AddressFamily[] {
  return [...new Set(endpoint.addresses.filter((address) => address.state === "current").map((address) => address.family))].sort();
}

export function reconcileEndpointFamily(current: AddressFamily, endpoint: EndpointWithAddresses): AddressFamily | null {
  const families = actualEndpointFamilies(endpoint);
  return families.includes(current) ? current : families[0] ?? null;
}
