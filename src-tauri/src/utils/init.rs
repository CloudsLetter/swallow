use std::io;
use crate::utils::file::init_config;
use crate::utils::sqlite;

pub fn init() -> io::Result<()>{
    init_config()?;
    sqlite::init_database().map_err(io::Error::other)?;
    Ok(())
}
