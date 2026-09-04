use std::io;
use crate::utils::file::init_config;
use crate::utils::sqlite;
use crate::utils::path::app_data_dir;

pub fn init() -> io::Result<()>{
    init_config()?;
    sqlite::init_database().map_err(io::Error::other)?;
    std::fs::create_dir_all(app_data_dir().join("session-logs"))?;
    Ok(())
}
