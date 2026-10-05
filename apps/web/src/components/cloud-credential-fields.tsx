"use client";

import { cloudCredentialDefinitions, cloudProviderDefinitions } from "@masterdns/contracts/cloud";
import { credentialDraftKind, type CredentialDraft } from "../lib/cloud-credentials";
import { Field } from "./ui";

export function CloudCredentialFields({ draft, setDraft, admin, disabled, changeKind }: { draft: CredentialDraft; setDraft: (value: CredentialDraft) => void; admin: boolean; disabled: boolean; changeKind: (value: CredentialDraft["credentialKind"]) => void }) {
  const kind = credentialDraftKind(draft);
  const provider = cloudProviderDefinitions[draft.provider];
  const selectableKinds = provider.credentialKinds.filter(value => admin || !cloudCredentialDefinitions[value].adminOnly);
  return <>{selectableKinds.length > 1 && <Field label="凭证来源"><select name="credentialKind" value={kind} disabled={disabled} onChange={(event) => changeKind(event.target.value as CredentialDraft["credentialKind"])}>{selectableKinds.map(value => <option key={value} value={value}>{cloudCredentialDefinitions[value].label}</option>)}</select></Field>}{cloudCredentialDefinitions[kind].fields.map(field => <Field key={field.key} label={field.label}><input name={field.key} type={field.secret ? "password" : "text"} autoComplete="off" value={draft[field.key]} disabled={disabled} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} required={!field.optional} /></Field>)}{provider.credentialNotice && <p className="muted span-2">{provider.credentialNotice}</p>}</>;
}
