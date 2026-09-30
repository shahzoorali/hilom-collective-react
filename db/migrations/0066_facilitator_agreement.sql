-- Digital facilitator partnership agreement.
--
-- Two tables:
--
--   facilitator_agreement_versions    the text, versioned. A version is editable
--                                     only while it is a draft; publishing
--                                     freezes it, and changing the agreement
--                                     means publishing a new version.
--   facilitator_agreement_acceptances the signature record. One row per
--                                     (facilitator, version), append-only.
--
-- The acceptance row is the evidence, so it stores what a dispute would ask
-- for: which version, a SHA-256 of the exact text signed, the typed legal name,
-- when, from which IP and browser, and under which Cognito account. Hilom's
-- counter-signature is a second timestamp on the same row, set when the
-- facilitator is approved (or immediately, for someone already approved).
--
-- Nothing is seeded as `current`. The seeded row is a DRAFT of the contract as
-- first written and is not enforced: until an admin publishes a version, no
-- one is asked to sign and nothing is gated. Publishing is the switch.

create table if not exists public.facilitator_agreement_versions (
  version          text primary key,
  title            text not null,
  body_md          text not null,
  hilom_signatory  text,
  hilom_address    text,
  status           text not null default 'draft'
                     check (status in ('draft', 'current', 'retired')),
  published_at     timestamptz,
  created_by       text,
  created_at       timestamptz not null default now()
);

-- At most one current version.
create unique index if not exists facilitator_agreement_one_current
  on public.facilitator_agreement_versions (status) where status = 'current';

create table if not exists public.facilitator_agreement_acceptances (
  id                 uuid primary key default gen_random_uuid(),
  facilitator_id     uuid not null references public.facilitators(id) on delete restrict,
  agreement_version  text not null references public.facilitator_agreement_versions(version),
  body_sha256        text not null,
  signer_name        text not null,
  signer_address     text not null,
  signer_contact     text not null,
  signed_at          timestamptz not null default now(),
  signer_ip          text,
  signer_user_agent  text,
  signer_cognito_sub text,
  countersigned_at   timestamptz,
  countersigned_by   text,
  unique (facilitator_id, agreement_version)
);

create index if not exists facilitator_agreement_acceptances_facilitator_idx
  on public.facilitator_agreement_acceptances (facilitator_id);

-- Append-only. A signature record that can be edited is not a record. The only
-- columns that may change after insert are the two counter-signature columns,
-- and only from null.
create or replace function public.facilitator_agreement_acceptances_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'facilitator_agreement_acceptances rows cannot be deleted';
  end if;
  if new.id is distinct from old.id
     or new.facilitator_id is distinct from old.facilitator_id
     or new.agreement_version is distinct from old.agreement_version
     or new.body_sha256 is distinct from old.body_sha256
     or new.signer_name is distinct from old.signer_name
     or new.signer_address is distinct from old.signer_address
     or new.signer_contact is distinct from old.signer_contact
     or new.signed_at is distinct from old.signed_at
     or new.signer_ip is distinct from old.signer_ip
     or new.signer_user_agent is distinct from old.signer_user_agent
     or new.signer_cognito_sub is distinct from old.signer_cognito_sub then
    raise exception 'facilitator_agreement_acceptances signature fields are immutable';
  end if;
  if old.countersigned_at is not null
     and (new.countersigned_at is distinct from old.countersigned_at
          or new.countersigned_by is distinct from old.countersigned_by) then
    raise exception 'facilitator_agreement_acceptances counter-signature is immutable';
  end if;
  return new;
end $$;

drop trigger if exists facilitator_agreement_acceptances_guard
  on public.facilitator_agreement_acceptances;
create trigger facilitator_agreement_acceptances_guard
  before update or delete on public.facilitator_agreement_acceptances
  for each row execute function public.facilitator_agreement_acceptances_guard();

-- A published version's text is frozen too. Status may still move
-- (draft -> current -> retired); the words may not.
create or replace function public.facilitator_agreement_versions_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'a published agreement version cannot be deleted';
    end if;
    return old;
  end if;
  if old.status <> 'draft'
     and (new.body_md is distinct from old.body_md
          or new.title is distinct from old.title
          or new.hilom_signatory is distinct from old.hilom_signatory
          or new.hilom_address is distinct from old.hilom_address
          or new.version is distinct from old.version) then
    raise exception 'a published agreement version is immutable; publish a new version instead';
  end if;
  return new;
end $$;

drop trigger if exists facilitator_agreement_versions_guard
  on public.facilitator_agreement_versions;
create trigger facilitator_agreement_versions_guard
  before update or delete on public.facilitator_agreement_versions
  for each row execute function public.facilitator_agreement_versions_guard();

-- Same layered lockdown as 0064: RLS on with no policy, anon/authenticated
-- revoked, and only the backend's service_role granted.
alter table public.facilitator_agreement_versions     enable row level security;
alter table public.facilitator_agreement_acceptances  enable row level security;

revoke all on public.facilitator_agreement_versions    from anon, authenticated;
revoke all on public.facilitator_agreement_acceptances from anon, authenticated;

grant select, insert, update, delete on public.facilitator_agreement_versions    to service_role;
grant select, insert, update         on public.facilitator_agreement_acceptances to service_role;

-- The contract as first drafted (db/agreements/facilitator-partnership-agreement-v1.md).
-- Placeholders in double braces are filled from the signer's particulars when
-- the agreement is shown and rendered.

insert into public.facilitator_agreement_versions (version, title, body_md, status, created_by)
values (
  '2026-09-30-draft',
  'Facilitator Partnership Agreement (first draft)',
  $agreement$# Facilitator Partnership Agreement

*A partnership rooted in care, coordinated by Hilom Collective*

This Facilitator Partnership Agreement ("Agreement") is entered into as of {{effective_date}} ("Effective Date"), by and between:

HILOM COLLECTIVE, represented by {{hilom_signatory}}, with principal address at {{hilom_address}} (hereinafter, "Hilom Collective" or "Hilom"); and

{{facilitator_name}} ("Facilitator"), of legal age, with address at {{facilitator_address}}, and contact details {{facilitator_contact}}.

Hilom Collective and the Facilitator are each referred to individually as a "Party" and collectively as the "Parties."

## 1. RECITALS

WHEREAS, Hilom Collective is a holistic health and wellness platform that connects everyday Filipinos to accessible, culturally grounded pathways to healing, and works with independent wellness practitioners to deliver Programs to its community;

WHEREAS, the Facilitator is an independent practitioner with skills, training, or expertise relevant to a Program, and wishes to be formally registered within the Hilom Collective network;

WHEREAS, Hilom Collective acts as mediator, coordinator, and sole point of contact between the Facilitator and Venue partners, clients, and community participants for each Engagement;

NOW, THEREFORE, in consideration of the mutual covenants contained herein, the Parties agree as follows:

## 2. DEFINITIONS

"Program" or "Workshop" refers to any wellness session, training, retreat, or activity that the Facilitator agrees to deliver under the Hilom Collective network.

"Engagement" refers to a specific, scheduled instance of a Program, as confirmed in writing between Hilom Collective and the Facilitator (an "Engagement Order").

"Base Fee" refers to the Facilitator's standard professional fee for a given Engagement, as declared by the Facilitator and honored by Hilom Collective.

"Top-Up" refers to any additional amount Hilom Collective provides on top of the Base Fee, depending on the specific requirements of an Engagement (e.g., travel, materials, extended hours, or venue conditions).

"Community Slot" refers to one to two (1–2) complimentary slots reserved in each Workshop for members of the Hilom Collective community, as described in Section 6.

## 3. REGISTRATION AND EXCLUSIVITY OF COORDINATION

Upon signing, the Facilitator becomes a registered Facilitator within the Hilom Collective network. For the duration of each Engagement, and for the Term of this Agreement, the Facilitator agrees that:

- All communication, scheduling, and coordination relating to Hilom Collective-sourced Engagements shall be conducted solely through Hilom Collective, and not directly with the Venue, client, or sponsor, unless Hilom Collective gives prior written consent;

- The Facilitator shall not independently solicit or accept separate bookings with a Venue or client introduced by Hilom Collective, outside of this Agreement, without Hilom Collective's prior written consent;

- Hilom Collective shall likewise manage all logistics, participant coordination, and on-ground support for the Engagement, so that the Facilitator may focus solely on program delivery.

- Non-Circumvention - During the Term of this Agreement and for twelve (12) months following its termination, the Facilitator shall not directly or indirectly engage, solicit, contract with, compensate, or otherwise retain any Venue first introduced through Hilom Collective without Hilom's prior written consent.

This exclusivity applies specifically to Venues, clients, and community relationships introduced through Hilom Collective, and does not restrict the Facilitator's independent practice or other engagements unrelated to Hilom Collective.

## 4. TERM

This Agreement shall take effect on the Effective Date and shall remain in force for a period of one (1) year ("Term"), covering all Engagements confirmed within that period, unless earlier terminated under Section 12. The Agreement may be renewed for successive periods upon the mutual written agreement of both Parties.

## 5. FEES AND PAYMENT

### 5.1 Base Fee

Hilom Collective shall honor the Facilitator's declared Base Fee for each confirmed Engagement, as stated in the applicable Engagement Order.

### 5.2 Top-Up

Depending on the specific requirements of an Engagement — including but not limited to travel and accommodation, program length, materials, or venue conditions — Hilom Collective shall provide a reasonable Top-Up amount on the Base Fee. The Top-Up shall be computed and disclosed to the Facilitator in writing prior to the Engagement, as part of the Engagement Order.

### 5.3 Payment Terms

The total fee (Base Fee plus Top-Up) shall be paid to the Facilitator by Hilom Collective according to the schedule stated in the Engagement Order, and in no case later than fifteen (15) days after the completed Engagement, unless otherwise agreed in writing.

### 5.4 Cancellation

If an Engagement is cancelled by Hilom Collective or the Venue less than fifteen (15) days before the scheduled date, for reasons other than force majeure, a reasonable cancellation fee shall be paid to the Facilitator, as agreed per Engagement.

### 5.5 Facilitator Cancellation

If facilitator cancels less than 15  days before, Hilom may recover costs or offset future payments

## 6. COMMUNITY SLOTS

For each Workshop, the Facilitator agrees to reserve one to two (1–2) Community Slots for members of the Hilom Collective community, to be registered by Hilom Collective. These Community Slots shall be offered free of charge to the selected community members and shall not reduce the Facilitator's Base Fee or Top-Up for the Engagement. Hilom Collective shall coordinate the selection and registration of participants for these slots.

## 7. MANAGEMENT AND SUPPORT BY HILOM COLLECTIVE

For the duration of each project or Workshop, Hilom Collective shall:

- Serve as the Facilitator's sole point of contact and manager for the Engagement, including all communications with the Venue, client, sponsor, and participants;

- Coordinate logistics, scheduling, and on-ground requirements so that the Program runs smoothly for the Facilitator, the Venue, and participants;

- Mediate and help resolve any concerns that arise before, during, or after the Engagement, in a manner that is fair and reasonable to all parties involved;

- Promote the Facilitator and the Workshop through Hilom Collective's website and social media, and community communications, as described in Section 8.

- Facilitator represents that they:

- possess required qualifications

- maintain certifications

- comply with applicable laws

- accurately represent credentials

- Facilitators must disclose existing relationships with the venue or client before accepting engagement.

## 8. MARKETING AND VISIBILITY

Hilom Collective shall, at no cost to the Facilitator, provide the following support in promoting confirmed Workshops:

A dedicated profile or feature for the Facilitator on the Hilom Collective website;

Promotion of confirmed Workshops across Hilom Collective's official social media channels;

Inclusion of the Facilitator as a recognized practitioner within the Hilom Collective community.

The Facilitator agrees that their name, professional background, and Program-related photos or materials may be used by Hilom Collective for these promotional purposes, subject to the Facilitator's prior review for accuracy.

## 9. INDEPENDENT CONTRACTOR STATUS

The Facilitator is engaged as an independent contractor and not as an employee, partner, or agent of Hilom Collective. Nothing in this Agreement shall be construed as creating an employer-employee relationship. The Facilitator shall remain solely responsible for their own professional licenses, taxes, and statutory obligations relating to their practice.

## 10. INTELLECTUAL PROPERTY AND PROGRAM MATERIALS

The Facilitator retains ownership of their original program content, methodology, and materials. The Facilitator grants Hilom Collective a limited, non-exclusive license to use, reproduce, and promote such materials solely for purposes directly related to marketing and delivering the Engagement. Any co-created materials developed specifically for a Hilom Collective Program shall be jointly owned unless otherwise agreed in writing.

## 11. CONFIDENTIALITY

Each Party agrees to keep confidential any personal, business, or participant information disclosed in connection with this Agreement, and shall not disclose such information to third parties without prior written consent, except as required by law.

### 11.1 Participant Privacy

Facilitator shall maintain confidentiality, not disclose participant stories, obtain consent before sharing testimonials, and comply with the Data Privacy Act

## 12. LIABILITY AND CONDUCT

- The Facilitator shall be responsible for the professional quality, safety, and appropriateness of the content and activities they deliver during an Engagement.

- Hilom Collective shall be responsible for the logistics, coordination, and conditions of the Engagement that are within its control, including Venue arrangements.

- Each Party shall indemnify the other for loss or damage directly arising from its own negligence, willful misconduct, or breach of this Agreement.

- Facilitator acknowledges that Programs are intended for education and wellness and do not constitute medical, psychiatric, or psychological treatment unless expressly identified and legally authorized.

- Facilitator responsible for providing informed consent, adapting activities, and stopping unsafe activities

## 13. TERMINATION

- Either Party may terminate this Agreement for material breach that remains uncured for thirty (30) days after written notice specifying the breach.

- Either Party may terminate this Agreement without cause upon thirty (30) days' prior written notice to the other Party.

- Hilom Collective may immediately terminate if the facilitator commits fraud, harassment, abuse, unethical conduct, criminal acts, or damages Hilom reputation.

- Termination shall not affect Engagements already confirmed and scheduled prior to the notice date, unless the Parties agree otherwise in writing, and any fees earned up to the effective date of termination shall remain payable.

## 14. FORCE MAJEURE

Neither Party shall be liable for delay or failure to perform its obligations under this Agreement where such delay or failure results from causes beyond its reasonable control, including but not limited to natural disasters, government action, public health emergencies, illness, or civil disturbance. The affected Party shall notify the other promptly, and both Parties shall work in good faith to reschedule any affected Engagement.

## 15. GOVERNING LAW AND DISPUTE RESOLUTION

This Agreement shall be governed by and construed in accordance with the laws of the Republic of the Philippines. The Parties shall first attempt to resolve any dispute arising from this Agreement through good-faith negotiation and, if unresolved within thirty (30) days, through mediation before resorting to the appropriate courts of Makati City, Philippines.

## 16. GENERAL PROVISIONS

Entire Agreement: This Agreement, together with any signed Engagement Orders, constitutes the entire understanding between the Parties and supersedes all prior discussions on the subject matter.

Amendments: Any amendment to this Agreement must be in writing and signed by both Parties.

Assignment: Neither Party may assign this Agreement without the prior written consent of the other Party.

Severability: If any provision of this Agreement is found invalid or unenforceable, the remaining provisions shall continue in full force and effect.

Notices: All notices under this Agreement shall be in writing and delivered to the addresses stated above, or such other address as either Party may designate in writing.

IN WITNESS WHEREOF, the Parties have executed this Agreement electronically, on the dates recorded in the signature record that follows.
$agreement$,
  'draft',
  'migration 0066'
)
on conflict (version) do nothing;
