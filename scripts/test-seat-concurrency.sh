#!/usr/bin/env bash
#
# Proves that event capacity actually holds under concurrency.
#
# 0016_event_ticketing.sql enforces capacity with a FOR UPDATE lock on the event
# row inside claim_event_seat(), backed by a partial unique index on
# (event_id, seat_no). That is a claim about behaviour under simultaneous
# writers, and the only way to believe it is to run simultaneous writers: the
# naive implementation (SELECT count, then INSERT) passes every sequential test
# and oversells on the first busy afternoon.
#
# This fires N concurrent claims at an event with M seats and asserts that
# exactly M succeed, that they hold seats 1..M with no duplicates, and that
# every loser failed with a clean `sold_out` rather than a constraint violation
# leaking out of the function.
#
# Usage:
#   scripts/test-seat-concurrency.sh [DATABASE_URL] [CLAIMANTS] [CAPACITY]
#
# Defaults to a local scratch database. Point it at a throwaway database only —
# it creates and drops an event, and it is not safe against real registrations.
#
#   scripts/test-seat-concurrency.sh                      # local hilom_scratch
#   scripts/test-seat-concurrency.sh "$STAGING_DB" 40 5
set -euo pipefail

DB="${1:-hilom_scratch}"
CLAIMANTS="${2:-20}"
CAPACITY="${3:-3}"
EV="22222222-2222-2222-2222-222222222222"

command -v psql >/dev/null || { echo "psql not on PATH"; exit 1; }

q() { psql -d "$DB" -v ON_ERROR_STOP=1 -tAq -c "$1"; }

echo "Setting up: capacity $CAPACITY, $CLAIMANTS simultaneous claimants"

q "delete from public.event_registrations where event_id = '$EV';
   delete from public.event_payment_plans  where event_id = '$EV';
   delete from public.events               where id       = '$EV';" >/dev/null

q "insert into public.events (id, title, starts_at, status, ticketing_enabled,
                              format, capacity, hold_minutes)
   values ('$EV', 'Concurrency probe', now() + interval '90 days', 'published',
           true, 'virtual', $CAPACITY, 60);" >/dev/null

PLAN=$(q "insert into public.event_payment_plans (event_id, name, kind, total_centavos)
          values ('$EV', 'Full', 'full', 100000) returning id;")

q "insert into public.event_plan_installments (plan_id, seq, label, amount_centavos, is_deposit)
   values ('$PLAN', 1, 'Full payment', 100000, true);" >/dev/null

CHARGES='[{"seq":1,"label":"Full payment","is_deposit":true,"amount_centavos":100000,"due_at":"2027-01-01T00:00:00Z"}]'

# Every claimant is launched before any of them is waited on, so they contend
# for the event row lock rather than queueing politely.
tmp=$(mktemp -d)
for i in $(seq 1 "$CLAIMANTS"); do
  (
    if psql -d "$DB" -tAq -c "select public.claim_event_seat(
         '$EV'::uuid, '$PLAN'::uuid, 'rush$i@example.com', 'sub-$i',
         '{\"name\":\"Rush $i\",\"email\":\"rush$i@example.com\"}'::jsonb,
         '$CHARGES'::jsonb, 60);" >"$tmp/$i.out" 2>"$tmp/$i.err"
    then echo won  >"$tmp/$i.result"
    else echo lost >"$tmp/$i.result"
    fi
  ) &
done
wait

# Counted by walking the files rather than with grep -l | wc -l: an empty match
# set makes grep exit 1, which under `set -e` would kill the run at exactly the
# moment there is a result worth printing.
won=0; lost=0; sold_out=0; other_err=0
for i in $(seq 1 "$CLAIMANTS"); do
  if [ "$(cat "$tmp/$i.result")" = "won" ]; then
    won=$((won + 1))
  else
    lost=$((lost + 1))
    if grep -q "sold_out" "$tmp/$i.err"; then
      sold_out=$((sold_out + 1))
    else
      other_err=$((other_err + 1))
      echo "  unexpected failure from claimant $i:"
      sed 's/^/    /' "$tmp/$i.err"
    fi
  fi
done

rows=$(q "select count(*) from public.event_registrations
           where event_id='$EV' and status in ('pending_payment','confirmed');")
distinct=$(q "select count(distinct seat_no) from public.event_registrations
               where event_id='$EV' and status in ('pending_payment','confirmed');")
seats=$(q "select coalesce(string_agg(seat_no::text, ',' order by seat_no), '-')
             from public.event_registrations
            where event_id='$EV' and status in ('pending_payment','confirmed');")
charges=$(q "select count(*) from public.registration_charges where event_id='$EV';")

echo
echo "  claims won        : $won   (expected $CAPACITY)"
echo "  claims lost       : $lost  (expected $((CLAIMANTS - CAPACITY)))"
echo "  clean 'sold_out'  : $sold_out"
echo "  unexpected errors : $other_err"
echo "  live registrations: $rows"
echo "  distinct seats    : $distinct"
echo "  seat numbers      : $seats"
echo "  charges written   : $charges"
echo

status=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1: got $2, wanted $3"; status=1; fi; }

check "exactly capacity claims succeeded"      "$won"      "$CAPACITY"
check "every other claim was refused"          "$lost"     "$((CLAIMANTS - CAPACITY))"
check "no seat was sold twice"                 "$distinct" "$CAPACITY"
check "rows match successful claims"           "$rows"     "$CAPACITY"
check "losers all failed with sold_out"        "$sold_out" "$((CLAIMANTS - CAPACITY))"
check "no constraint violation escaped"        "$other_err" "0"
check "one charge per winner, none orphaned"   "$charges"  "$CAPACITY"

rm -rf "$tmp"
q "delete from public.event_registrations where event_id='$EV';
   delete from public.event_payment_plans  where event_id='$EV';
   delete from public.events               where id='$EV';" >/dev/null

echo
[ $status -eq 0 ] && echo "Capacity holds under concurrency." || echo "CAPACITY IS NOT SAFE — do not ship."
exit $status
