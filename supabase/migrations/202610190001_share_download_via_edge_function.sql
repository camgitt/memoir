-- Share bundles: replace the anonymous Storage read rule from
-- 202610180001 with the share-download edge function
-- (supabase/functions/share-download). The rule let anyone list every active
-- bundle, and each bundle name contains its share token.
drop policy if exists "Recipients read active shared bundles" on storage.objects;
drop function if exists public.memoir_can_read_shared_object(text);

-- Only share-download (service role) uses up a share now, at download time.
revoke execute on function public.memoir_consume_shared_link(text) from anon, authenticated;
