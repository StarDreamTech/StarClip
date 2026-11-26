use super::*;
use std::collections::BTreeSet;

const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
struct HistoryGlobalStamp {
    changes: u64,
    data_version: i64,
    schema_version: i64,
}

#[derive(Clone)]
pub(super) struct HistoryGlobal {
    pub counts: BTreeMap<String, u64>,
    pub group_counts: BTreeMap<i64, u64>,
    pub sources: Vec<String>,
    pub hosts: Vec<String>,
    pub tags: Vec<String>,
}

impl HistoryGlobal {
    fn estimated_bytes(&self) -> usize {
        // An approximate retention budget, not a process RSS limit. Do not keep
        // unusually large facets in addition to the complete response itself.
        let mut bytes =
            std::mem::size_of::<Self>().saturating_add(self.group_counts.len().saturating_mul(48));
        for key in self.counts.keys() {
            bytes = bytes.saturating_add(key.len()).saturating_add(64);
        }
        for value in self.sources.iter().chain(&self.hosts).chain(&self.tags) {
            bytes = bytes
                .saturating_add(value.len())
                .saturating_add(std::mem::size_of::<String>());
        }
        bytes
    }
}

pub(super) struct CachedHistoryGlobal {
    stamp: HistoryGlobalStamp,
    value: HistoryGlobal,
}

fn collect_json_strings(value: Option<&serde_json::Value>, out: &mut BTreeSet<String>) {
    match value {
        Some(serde_json::Value::String(text)) => {
            out.insert(text.clone());
        }
        Some(serde_json::Value::Array(items)) => {
            for item in items {
                if let serde_json::Value::String(text) = item {
                    out.insert(text.clone());
                }
            }
        }
        Some(serde_json::Value::Object(map)) => {
            for item in map.values() {
                if let serde_json::Value::String(text) = item {
                    out.insert(text.clone());
                }
            }
        }
        _ => {}
    }
}

impl Store {
    /// Wrap a write that only mutates non-history tables (such as `preferences`)
    /// so it does not unnecessarily invalidate the cached global history facets.
    pub(super) fn execute_non_history_write<T>(
        &self,
        write: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let track = self.conn.is_autocommit();
        let before = self.conn.total_changes();
        let result = write();
        if track && result.is_ok() && self.conn.is_autocommit() {
            let delta = self.conn.total_changes().saturating_sub(before);
            self.ignored_changes
                .set(self.ignored_changes.get().saturating_add(delta));
        }
        result
    }

    fn history_global_stamp(&self) -> Result<HistoryGlobalStamp> {
        Ok(HistoryGlobalStamp {
            changes: self
                .conn
                .total_changes()
                .saturating_sub(self.ignored_changes.get()),
            data_version: self
                .conn
                .pragma_query_value(None, "data_version", |row| row.get(0))
                .map_err(sql_error)?,
            schema_version: self
                .conn
                .pragma_query_value(None, "schema_version", |row| row.get(0))
                .map_err(sql_error)?,
        })
    }

    pub(super) fn history_global(&self) -> Result<HistoryGlobal> {
        // Autocommit can remain true while a live Rows cursor pins a read
        // snapshot. Neither explicit transactions nor those older snapshots
        // may consume or publish the shared committed-data cache.
        if !self.conn.is_autocommit() || self.conn.is_busy() {
            self.history_global_cache.borrow_mut().take();
            return self.query_history_global();
        }
        let before = self.history_global_stamp()?;
        {
            let mut cached = self.history_global_cache.borrow_mut();
            if let Some(entry) = cached.as_ref().filter(|entry| entry.stamp == before) {
                return Ok(entry.value.clone());
            }
            cached.take();
        }
        // All uncached aggregates use one read snapshot. Compare versions only
        // after leaving it: an external commit during the read must not label
        // the old snapshot with the new database version.
        let tx = rusqlite::Transaction::new_unchecked(
            &self.conn,
            rusqlite::TransactionBehavior::Deferred,
        )
        .map_err(sql_error)?;
        let value = self.query_history_global()?;
        tx.commit().map_err(sql_error)?;
        if self.history_global_stamp()? == before && value.estimated_bytes() <= MAX_CACHE_BYTES {
            *self.history_global_cache.borrow_mut() = Some(CachedHistoryGlobal {
                stamp: before,
                value: value.clone(),
            });
        }
        Ok(value)
    }

    #[cfg(test)]
    pub(super) fn history_global_query_count(&self) -> u64 {
        self.history_global_queries.get()
    }

    fn query_history_global(&self) -> Result<HistoryGlobal> {
        #[cfg(test)]
        self.history_global_queries
            .set(self.history_global_queries.get().saturating_add(1));

        let mut counts = BTreeMap::new();
        let mut pinned_total = 0u64;
        let mut kept_total = 0u64;
        let mut statement = self
            .conn
            .prepare(
                "SELECT kind,COUNT(*),COALESCE(SUM(CASE WHEN pinned=1 THEN 1 ELSE 0 END),0),COALESCE(SUM(CASE WHEN keep_forever=1 THEN 1 ELSE 0 END),0) FROM clips GROUP BY kind",
            )
            .map_err(sql_error)?;
        for item in statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u64>(3)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (kind, count, pinned, kept) = item.map_err(sql_error)?;
            counts.insert(kind, count);
            pinned_total = pinned_total.saturating_add(pinned);
            kept_total = kept_total.saturating_add(kept);
        }
        counts.insert("all".into(), counts.values().sum());
        let bundles = counts.remove("bundle").unwrap_or(0);
        *counts.entry("image".into()).or_default() += bundles;
        counts.insert("pinned".into(), pinned_total);
        counts.insert("kept".into(), kept_total);

        let link_count: u64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM clips c LEFT JOIN clip_privacy p ON p.clip_id=c.id WHERE c.kind='link' OR json_array_length(p.metadata,'$.linkHosts')>0",
                [],
                |row| row.get(0),
            )
            .map_err(sql_error)?;
        counts.insert("link".into(), link_count);

        let mut statement = self
            .conn
            .prepare(
                "SELECT group_id,COUNT(*) FROM clips WHERE group_id IS NOT NULL GROUP BY group_id",
            )
            .map_err(sql_error)?;
        let group_counts = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(sql_error)?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()
            .map_err(sql_error)?;

        let mut sources = BTreeSet::new();
        let mut hosts = BTreeSet::new();
        let mut tags = BTreeSet::new();
        let mut statement = self
            .conn
            .prepare(
                "SELECT metadata FROM clip_privacy WHERE metadata IS NOT NULL AND metadata<>'{}'",
            )
            .map_err(sql_error)?;
        let mut rows = statement.query([]).map_err(sql_error)?;
        while let Some(row) = rows.next().map_err(sql_error)? {
            let raw: String = row.get(0).map_err(sql_error)?;
            if let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&raw) {
                collect_json_strings(map.get("linkSources"), &mut sources);
                collect_json_strings(map.get("originSources"), &mut sources);
                collect_json_strings(map.get("linkHosts"), &mut hosts);
                collect_json_strings(map.get("originHosts"), &mut hosts);
                collect_json_strings(map.get("manualTags"), &mut tags);
                collect_json_strings(map.get("ruleTags"), &mut tags);
                collect_json_strings(map.get("appTags"), &mut tags);
            }
        }

        Ok(HistoryGlobal {
            counts,
            group_counts,
            sources: sources.into_iter().collect(),
            hosts: hosts.into_iter().collect(),
            tags: tags.into_iter().collect(),
        })
    }
}
