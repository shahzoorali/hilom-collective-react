#!/usr/bin/env bash
#
# Proves that group class capacity holds under concurrency (0049).
#
# `claim_class_seat()` enforces capacity with a FOR UPDATE lock on the session
# row, backed by a partial unique index on (session_id, seat_no). That is a
# claim about behaviour under simultaneous writers, and the only way to believe
# it is to run simultaneous writers: the naive implementation (SELECT count,
# then INSERT) passes every sequential test and oversells on the first busy
# afternoon.
#
# The sibling of scripts/test-seat-concurrency.sh, which does the same for
# ticketed events. Kept as a second script rather than a flag on that one
# because the two functions have genuinely different contracts — a class also
# enforces **one place per person**, which an event deliberately does not, and
# that rule has its own race.
#
# Two things are asserted that the event script has no equivalent for:
#
#   * one client hammering Join from several tabs gets exactly one seat, and
#     the losers fail with a clean `already_registered`
#   * a lapsed hold is released and its seat number resold, rather than the
#     class silently shrinking by the number of abandoned checkouts
#
# Usage:
#   scripts/test-class-seat-concurrency.sh [DATABASE_URL] [CLAIMANTS] [CAPACITY]
#
# Point it at a throwaway database only — it creates and drops a facilitator,
# a class and a session, and it is not safe against real registrations.
#
#   scripts/test-class-seat-concurrency.sh                  # local hilom_scratch
#   scripts/test-class-seat-concurrency.sh "$STAGING_DB" 30 4
set -euo pipefail

DB="${1:-hilom_scratch}"
CLAIMANTS="${2:-20}"
CAPACITY="${3:-3}"

FAC="33333333-3333-3333-3333-333333333333"
CLS="44444444-4444-4444-4444-444444444444"
SES="55555555-5555-5555-5555-555555555555"

command -v psql >/dev/null || { echo "psql not on PATH"; exit 1; }

q() { psql -d "$DB" -v ON_ERROR_STOP=1 -tAq -c "$1"; }

cleanup() {
  q "delete from public.class_registrations        where session_id = '$SES';
     delete from public.facilitator_class_sessions where id         = '$SES';
     delete from public.facilitator_classes        where id         = '$CLS';
     delete from public.facilitators               where id         = '$FAC';" >/dev/null
}

echo "Setting up: capacity $CAPACITY, $CLAIMANTS simultaneous claimants"
cleanup

q "insert into public.facilitators (id, slug, display_name, email, status, timezone)
   values ('$FAC', 'concurrency-probe', 'Concurrency Probe',
           'probe@example.com', 'published', 'Asia/Manila');" >/dev/null

q "insert into public.facilitator_classes
     (id, facilitator_id, title, delivery_mode, duration_minutes,
      price_centavos, min_joiners, max_joiners)
   values ('$CLS', '$FAC', 'Concurrency probe', 'online', 60,
           100000, 1, $CAPACITY);" >/dev/null

q "insert into public.facilitator_class_sessions
     (id, class_id, facilitator_id, starts_at, ends_at,
      price_centavos, capacity, min_joiners, status)
   values ('$SES', '$CLS', '$FAC',
           now() + interval '30 days', now() + interval '30 days 1 hour',
           100000, $CAPACITY, 1, 'scheduled');" >/dev/null

# ---------------------------------------------------------------------------
# Round 1 — distinct clients contending for the last seats
# ---------------------------------------------------------------------------
# Every claimant is launched before any is waited on, so they contend for the
# session row lock rather than queueing politely.
tmp=$(mktemp -d)
for i in $(seq 1 "$CLAIMANTS"); do
  (
    if psql -d "$DB" -tAq -c "select public.claim_class_seat(
         '$SES'::uuid, 'rush$i@example.com', 'sub-$i', 'Rush $i', null, 20);" \
         >"$tmp/$i.out" 2>"$tmp/$i.err"
    then echo won  >"$tmp/$i.result"
    else echo lost >"$tmp/$i.result"
    fi
  ) &
done
wait

# Walked rather than counted with `grep -l | wc -l`: an empty match set makes
# grep exit 1, which under `set -e` kills the run at exactly the moment there
# is a result worth printing.
won=0; lost=0; full=0; other_err=0
for i in $(seq 1 "$CLAIMANTS"); do
  if [ "$(cat "$tmp/$i.result")" = "won" ]; then
    won=$((won + 1))
  else
    lost=$((lost + 1))
    if grep -q "class_full" "$tmp/$i.err"; then
      full=$((full + 1))
    else
      other_err=$((other_err + 1))
      echo "  unexpected failure from claimant $i:"
      sed 's/^/    /' "$tmp/$i.err"
    fi
  fi
done

rows=$(q "select count(*) from public.class_registrations
           where session_id='$SES' and status in ('pending_payment','confirmed');")
distinct=$(q "select count(distinct seat_no) from public.class_registrations
               where session_id='$SES' and status in ('pending_payment','confirmed');")
seats=$(q "select coalesce(string_agg(seat_no::text, ',' order by seat_no), '-')
             from public.class_registrations
            where session_id='$SES' and status in ('pending_payment','confirmed');")

# ---------------------------------------------------------------------------
# Round 2 — one person, many tabs
# ---------------------------------------------------------------------------
# The unique index on (session_id, lower(client_email)) is what stops someone
# double-booking themselves by mashing Join. Freeing the class first so the
# only thing that can refuse them is that rule, not capacity.
q "delete from public.class_registrations where session_id='$SES';" >/dev/null

dup=$(mktemp -d)
for i in $(seq 1 5); do
  (
    if psql -d "$DB" -tAq -c "select public.claim_class_seat(
         '$SES'::uuid, 'Keen@Example.com', 'sub-keen', 'Keen', null, 20);" \
         >"$dup/$i.out" 2>"$dup/$i.err"
    then echo won  >"$dup/$i.result"
    else echo lost >"$dup/$i.result"
    fi
  ) &
done
wait

dup_won=0; dup_clean=0; dup_other=0
for i in $(seq 1 5); do
  if [ "$(cat "$dup/$i.result")" = "won" ]; then
    dup_won=$((dup_won + 1))
  elif grep -qE "already_registered|class_registrations_one_per_client_idx" "$dup/$i.err"; then
    dup_clean=$((dup_clean + 1))
  else
    dup_other=$((dup_other + 1))
    echo "  unexpected failure from duplicate attempt $i:"
    sed 's/^/    /' "$dup/$i.err"
  fi
done

# Case-insensitive: they typed it with a capital the second time.
dup_rows=$(q "select count(*) from public.class_registrations
               where session_id='$SES' and lower(client_email)='keen@example.com'
                 and status in ('pending_payment','confirmed');")

# ---------------------------------------------------------------------------
# Round 3 — a lapsed hold frees its seat, and the number is reused
# ---------------------------------------------------------------------------
# Without the inline release in claim_class_seat, an abandoned checkout would
# sterilise a seat until the sweep next ran, and a busy class would shrink by
# the number of people who changed their mind.
q "delete from public.class_registrations where session_id='$SES';" >/dev/null
q "select public.claim_class_seat('$SES'::uuid, 'lapsed@example.com', 'sub-lapsed', 'Lapsed', null, 20);" >/dev/null
q "update public.class_registrations
      set hold_expires_at = now() - interval '1 hour'
    where session_id='$SES' and lower(client_email)='lapsed@example.com';" >/dev/null

q "select public.claim_class_seat('$SES'::uuid, 'next@example.com', 'sub-next', 'Next', null, 20);" >/dev/null

reused=$(q "select seat_no from public.class_registrations
             where session_id='$SES' and lower(client_email)='next@example.com';")
expired=$(q "select count(*) from public.class_registrations
              where session_id='$SES' and status='expired';")

echo
echo "  claims won            : $won   (expected $CAPACITY)"
echo "  claims lost           : $lost  (expected $((CLAIMANTS - CAPACITY)))"
echo "  clean 'class_full'    : $full"
echo "  unexpected errors     : $other_err"
echo "  live registrations    : $rows"
echo "  distinct seats        : $distinct"
echo "  seat numbers          : $seats"
echo "  same person, seats won: $dup_won   (expected 1)"
echo "  duplicate refusals    : $dup_clean"
echo "  reused seat number    : $reused (expected 1)"
echo "  lapsed holds expired  : $expired"
echo

status=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1: got $2, wanted $3"; status=1; fi; }

check "exactly capacity claims succeeded"        "$won"       "$CAPACITY"
check "every other claim was refused"            "$lost"      "$((CLAIMANTS - CAPACITY))"
check "no seat was sold twice"                   "$distinct"  "$CAPACITY"
check "rows match successful claims"             "$rows"      "$CAPACITY"
check "losers all failed with class_full"        "$full"      "$((CLAIMANTS - CAPACITY))"
check "no constraint violation escaped"          "$other_err" "0"
check "one person gets exactly one place"        "$dup_won"   "1"
check "their other attempts were refused"        "$dup_clean" "4"
check "no unexpected duplicate errors"           "$dup_other" "0"
check "only one row for that person"             "$dup_rows"  "1"
check "a lapsed hold releases its seat number"   "$reused"    "1"
check "the lapsed hold is marked expired"        "$expired"   "1"

rm -rf "$tmp" "$dup"
cleanup

echo
[ $status -eq 0 ] && echo "Class capacity holds under concurrency." || echo "CLASS CAPACITY IS NOT SAFE — do not ship."
exit $status
