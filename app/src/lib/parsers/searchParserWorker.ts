
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { googleSearch } from './searchScraper';

export async function runSearchParserJob(jobId: string) {
  if (!supabaseAdmin) {
    console.error('supabaseAdmin not configured');
    return;
  }

  try {
    // 1. Fetch job
    const { data: job, error } = await supabaseAdmin
      .from('search_parser_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) {
      console.error('Job not found:', jobId);
      return;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return;
    }

    // 2. Set running
    await supabaseAdmin
      .from('search_parser_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', jobId);

    const queries = (job.config as { queries?: string[] })?.queries || [];
    let totalResults = 0;
    let processedQueries = 0;

    // 3. Process queries
    for (const query of queries) {
      // Check for cancellation
      const { data: currentJob } = await supabaseAdmin
        .from('search_parser_jobs')
        .select('status')
        .eq('id', jobId)
        .single();
        
      if (currentJob?.status === 'failed') { // If cancelled/failed externally
         return; 
      }

      try {
        const results = await googleSearch(query);
        
        if (results.length > 0) {
          const rows = results.map(r => ({
            job_id: jobId,
            query: r.query,
            title: r.title,
            link: r.link,
            snippet: r.snippet,
            position: r.position
          }));

          await supabaseAdmin.from('search_results').insert(rows);
          totalResults += results.length;
        }

        processedQueries++;
        
        // Update progress
        await supabaseAdmin
          .from('search_parser_jobs')
          .update({ 
            processed_queries: processedQueries,
            total_results: totalResults 
          })
          .eq('id', jobId);

      } catch (err) {
        console.error(`Error processing query "${query}":`, err);
        // We continue with other queries even if one fails
      }
    }

    // 4. Complete
    await supabaseAdmin
      .from('search_parser_jobs')
      .update({ 
        status: 'completed', 
        completed_at: new Date().toISOString(),
        processed_queries: processedQueries,
        total_results: totalResults
      })
      .eq('id', jobId);

  } catch (err) {
    console.error('Search parser worker failed:', err);
    if (supabaseAdmin) {
      await supabaseAdmin
        .from('search_parser_jobs')
        .update({ 
          status: 'failed', 
          error_message: err instanceof Error ? err.message : 'Unknown error',
          completed_at: new Date().toISOString()
        })
        .eq('id', jobId);
    }
  }
}
