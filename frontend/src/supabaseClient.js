import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://nvcnhrisyurilwtkiplg.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52Y25ocmlzeXVyaWx3dGtpcGxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3MjA4NzMsImV4cCI6MjA5MTI5Njg3M30.SiybcwaM3rLWu0V-JqxHbj0iVUNFAL-R1t6CFWU5zA4";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
