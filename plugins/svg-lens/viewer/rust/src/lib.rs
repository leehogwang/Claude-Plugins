use std::alloc::{alloc as std_alloc, dealloc as std_dealloc, Layout};
use std::slice;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let layout = Layout::from_size_align(len, 1).unwrap();
    unsafe { std_alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 1).unwrap();
    unsafe { std_dealloc(ptr, layout) }
}

static mut OUT_VIEWBOX: [f64; 2] = [2000.0, 1200.0];
static mut OUT_MINIMAP: [f64; 4] = [0.0, 0.0, 10.0, 10.0];

#[no_mangle]
pub extern "C" fn parse_svg_dims(ptr: *const u8, len: usize) -> *const f64 {
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    let head_len = bytes.len().min(4096);
    if let Ok(head) = std::str::from_utf8(&bytes[..head_len]) {
        if let Some(pos) = head.find("viewBox=\"") {
            let rest = &head[pos + 9..];
            if let Some(end) = rest.find('"') {
                let nums: Vec<f64> = rest[..end]
                    .split_whitespace()
                    .filter_map(|s| s.parse::<f64>().ok())
                    .collect();
                if nums.len() == 4 && nums[2] > 0.0 && nums[3] > 0.0 {
                    unsafe {
                        OUT_VIEWBOX[0] = nums[2];
                        OUT_VIEWBOX[1] = nums[3];
                    }
                    return std::ptr::addr_of!(OUT_VIEWBOX) as *const f64;
                }
            }
        }
    }
    unsafe {
        OUT_VIEWBOX[0] = 2000.0;
        OUT_VIEWBOX[1] = 1200.0;
    }
    std::ptr::addr_of!(OUT_VIEWBOX) as *const f64
}

#[no_mangle]
pub extern "C" fn compute_minimap_vb(
    vx: f64,
    vy: f64,
    vw: f64,
    vh: f64,
    svg_w: f64,
    svg_h: f64,
    mm_w: f64,
    mm_h: f64,
) -> *const f64 {
    let x0 = vx.max(0.0).min(svg_w);
    let y0 = vy.max(0.0).min(svg_h);
    let w = vw.min(svg_w).max(1.0);
    let h = vh.min(svg_h).max(1.0);
    unsafe {
        OUT_MINIMAP[0] = (x0 / svg_w) * mm_w;
        OUT_MINIMAP[1] = (y0 / svg_h) * mm_h;
        OUT_MINIMAP[2] = ((w / svg_w) * mm_w).max(4.0).min(mm_w);
        OUT_MINIMAP[3] = ((h / svg_h) * mm_h).max(4.0).min(mm_h);
    }
    std::ptr::addr_of!(OUT_MINIMAP) as *const f64
}
