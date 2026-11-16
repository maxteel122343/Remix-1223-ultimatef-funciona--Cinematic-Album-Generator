
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dwmwskccjxayqancukvg.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR3bXdza2NjanhheXFhbmN1a3ZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxNzg5NDUsImV4cCI6MjA4NDc1NDk0NX0.eZbTnsmY3mbTklnR2hysPDFli1EJ4x2GhTwxcH466bY';

export const supabase = createClient(supabaseUrl, supabaseKey);
