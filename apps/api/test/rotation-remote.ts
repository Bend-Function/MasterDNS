import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/** Only the remote control planes are fake. State lives in the parent across SIGKILL. */
export async function remoteControlPlane() {
  const instances = new Map<string, any>();
  const allocations: any[] = [];
  const events: string[] = [];
  const records = new Map<string, any>();
  let recordSequence = 0;
  let crashOccurrence = 1;
  let crashBeforeEffect = false;
  let crashAt: string | undefined;
  let crashed: (() => void) | undefined;
  let writesToUnmanaged = 0;
  function add(instanceId: string, interfaceId: string, old: string, candidate: string) {
    const eni = { NetworkInterfaceId: interfaceId, Attachment: { InstanceId: instanceId, DeviceIndex: 0 }, PrivateIpAddresses: [{ Primary: true, PrivateIpAddress: '10.0.0.10', Association: { PublicIp: old, AllocationId: `old-${instanceId}` } }] };
    instances.set(instanceId, { eni, candidate });
    allocations.push({ PublicIp: old, AllocationId: `old-${instanceId}`, NetworkInterfaceId: interfaceId, PrivateIpAddress: '10.0.0.10', AssociationId: `old-assoc-${instanceId}`, Tags: [] });
  }
  function cloud(name: string, input: any) {
    const instance = input.InstanceIds?.[0] ?? input.Filters?.find((f: any) => f.Name === 'attachment.instance-id')?.Values[0];
    if (name === 'GetCallerIdentityCommand') return { Account: '123456789012' };
    if (name === 'DescribeInstancesCommand') { assert(instances.has(instance)); return { Reservations: [{ Instances: [{ InstanceId: instance, State: { Name: 'running' } }] }] }; }
    if (name === 'DescribeNetworkInterfacesCommand') return { NetworkInterfaces: [...instances.values()].filter(s => input.NetworkInterfaceIds ? input.NetworkInterfaceIds.includes(s.eni.NetworkInterfaceId) : s.eni.Attachment.InstanceId === instance).map(s => s.eni) };
    if (name === 'DescribeAddressesCommand') return { Addresses: allocations.filter(a => input.AllocationIds ? input.AllocationIds.includes(a.AllocationId) : (input.Filters ?? []).every((f: any) => a.Tags.some((t: any) => `tag:${t.Key}` === f.Name && f.Values.includes(t.Value)))) };
    if (name === 'AllocateAddressCommand') {
      const tags = input.TagSpecifications[0].Tags;
      const slotTag = tags.find((t: any) => t.Key === 'masterdns:slot');
      assert(slotTag, 'allocation must carry durable ownership tags');
      const selected = [...instances.values()].find(s => s.slotId === slotTag.Value); assert(selected);
      assert(!allocations.some(a => a.PublicIp === selected.candidate), 'public allocation addresses must remain unique');
      const allocation = { PublicIp: selected.candidate, AllocationId: `eipalloc-${allocations.length}`, Tags: tags };
      allocations.push(allocation); events.push('cloud_allocated'); return allocation;
    }
    if (name === 'AssociateAddressCommand') {
      const selected = [...instances.values()].find(s => s.eni.NetworkInterfaceId === input.NetworkInterfaceId);
      if (!selected) { writesToUnmanaged++; throw new Error('unmanaged interface'); }
      const allocation = allocations.find(a => a.AllocationId === input.AllocationId); assert(allocation);
      for (const old of allocations.filter(a => a.NetworkInterfaceId === input.NetworkInterfaceId)) { delete old.NetworkInterfaceId; delete old.PrivateIpAddress; delete old.AssociationId; }
      Object.assign(allocation, { NetworkInterfaceId: input.NetworkInterfaceId, PrivateIpAddress: input.PrivateIpAddress, AssociationId: `assoc-${allocation.AllocationId}` });
      selected.eni.PrivateIpAddresses[0].Association = { PublicIp: allocation.PublicIp, AllocationId: allocation.AllocationId };
      events.push('cloud_attached'); return { AssociationId: allocation.AssociationId };
    }
    if (name === 'ReleaseAddressCommand') { const i = allocations.findIndex(a => a.AllocationId === input.AllocationId); assert(i >= 0 && !allocations[i].NetworkInterfaceId); allocations.splice(i, 1); events.push('cloud_released'); return {}; }
    throw new Error(`Unexpected remote cloud operation ${name}`);
  }
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const { name, input } = JSON.parse(body);
      const shouldCrash = name === crashAt && --crashOccurrence === 0;
      if (shouldCrash && crashBeforeEffect) { crashAt = undefined; crashed?.(); return; }
      let result;
      if (name === 'checkpoint.cleanup') result = {};
      else if (name === 'dns.list') result = { result: [...records.values()].filter(r => r.zone_id === input.zone_id) };
      else if (name === 'dns.get') result = records.get(input.id) ?? null;
      else if (name === 'dns.create') { result = { ...input, id: `dns-${++recordSequence}` }; records.set(result.id, result); events.push('dns_created'); }
      else if (name === 'dns.update') { assert(records.has(input.id)); result = { ...input }; records.set(input.id, result); events.push('dns_updated'); }
      else if (name === 'dns.delete') { assert(records.delete(input.id)); result = {}; events.push('dns_deleted'); }
      else result = cloud(name, input);
      if (shouldCrash) { crashAt = undefined; crashed?.(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, add, instances, allocations, records, events,
    get writesToUnmanaged() { return writesToUnmanaged; },
    failAt(name: string, occurrence = 1, beforeEffect = false) { crashAt = name; crashOccurrence = occurrence; crashBeforeEffect = beforeEffect; return new Promise<void>(resolve => { crashed = resolve; }); },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
