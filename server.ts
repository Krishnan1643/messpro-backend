import express from "express";
import path from "path";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import * as cheerio from 'cheerio';

async function startServer() {
  const app = express();
  // Changed to use Render's dynamic port
  const PORT = process.env.PORT || 3000; 

  app.use(cors());
  app.use(express.json());

  app.use(cors());
  app.use(express.json());

  // Explicitly serve public folder assets (manifest, sw.js, etc.)
  app.use(express.static(path.join(process.cwd(), "public")));

  // Ensure manifest.json is served with correct type
  app.get("/manifest.json", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "manifest.json"));
  });

  // Ensure sw.js is served with correct type
  app.get("/sw.js", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "sw.js"));
  });

  // Ensure directories for profile photos exist
  const uploadDir = path.join(process.cwd(), "public", "profiles");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // PSG Tech Authentication Proxy (using the logic from the Python script)
  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    try {
      const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";
      
      // 1. Authenticate
      const params = new URLSearchParams();
      params.append('name', username);
      params.append('password', password);

      console.log(`[Auth] Attempting login for ${username}...`);
      const loginResponse = await axios.post(`${BASE_URL}/Login/Authenticate`, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 30000
      });

      if (loginResponse.status !== 200) {
        return res.status(401).json({ error: "Invalid Roll Number or Password" });
      }

      const token = loginResponse.data?.Token;
      if (!token) {
        return res.status(401).json({ error: "Invalid Roll Number or Password" });
      }

      // Capture cookies for session persistence
      const loginCookies = loginResponse.headers['set-cookie'];
      const sessionCookies = Array.isArray(loginCookies) ? loginCookies.join('; ') : '';

      const authHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0',
        ...(sessionCookies ? { 'Cookie': sessionCookies } : {})
      };

      // 2. Fetch Student Details
      console.log(`[Auth] Fetching student details for ${username}...`);
      const studResp = await axios.get(`${BASE_URL}/Student/studDetails?rollno=${username}`, {
        headers: authHeaders,
        timeout: 30000
      });

      let studentData: any = {};
      if (studResp.data && studResp.data.length > 0) {
        studentData = studResp.data[0];
        
        // 3. Save profile photo (as requested: "save profile photo in app storage as did in the py code")
        const base64Image = studentData.StudPic;
        if (base64Image) {
          try {
            let actualBase64 = base64Image;
            if (base64Image.includes(',')) {
              actualBase64 = base64Image.split(',')[1];
            }
            const buffer = Buffer.from(actualBase64, 'base64');
            const filename = `profile_photo_${username}.jpg`;
            const filePath = path.join(uploadDir, filename);
            fs.writeFileSync(filePath, buffer);
            console.log(`[Auth] Profile photo saved to ${filePath}`);
            
            // Add a URL for the frontend to access it
            studentData.profilePhotoUrl = `/profiles/${filename}`;
          } catch (imgError) {
            console.error("[Auth] Failed to save profile image:", imgError);
          }
        }
      }

      // 4. Optionally fetch Room Details
      const roomResp = await axios.get(`${BASE_URL}/Student/roomDetails?rollno=${username}`, {
        headers: authHeaders
      }).catch(() => null);

      if (roomResp && roomResp.data && roomResp.data.length > 0) {
        studentData.roomDetails = roomResp.data[0];
      }
      // 5. Fetch Mess Balance / Hostel Fees Details
      console.log(`[Auth] Fetching mess balance and fees details for ${username}...`);
      const feesParams = new URLSearchParams();
      feesParams.append('rollno', username);

      const feesResp = await axios.post(`${BASE_URL}/Student/StudHosFeesDet?rollno=${username}`, feesParams.toString(), {
        headers: {
          ...authHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        timeout: 30000
      }).catch((feesError) => {
        console.error("[Auth] Failed to fetch fees details:", feesError.message);
        return null;
      });

      if (feesResp && feesResp.data) {
        studentData.feesDetails = Array.isArray(feesResp.data) ? feesResp.data : [feesResp.data];
        console.log(`[Auth] Fees details fetched! Entries: ${studentData.feesDetails.length}`);
      }

      res.json({ 
        success: true, 
        student: studentData,
        token: token,
        cookies: sessionCookies // Returning cookies for session persistence in tokens call
      });

    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;
      const errorMessage = error.message;

      // Suppress logging for expected 401/403 authentication failures
      if (status !== 401 && status !== 403) {
        console.error(`[Auth Error] Status: ${status} | Msg: ${errorMessage}`, errorData);
      }
      
      if (status === 401 || status === 403) {
        return res.status(401).json({ 
          success: false,
          error: "Invalid Roll Number or Password", 
          details: "The credentials provided were rejected by the PSG Tech server." 
        });
      }

      res.status(status || 500).json({ 
        success: false,
        error: "PSG Tech Server Error", 
        details: errorData || errorMessage || "An unexpected error occurred during authentication." 
      });
    }
  });

  // Fetch Current Tokens Proxy
  app.post("/api/tokens", async (req, res) => {
    const { username, token, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!username || !token) {
      console.error("[Tokens] Missing username or token in request body");
      return res.status(400).json({ error: "Username and token are required" });
    }

    try {
      console.log(`[Tokens] Fetching current tokens for ${username}...`);
      
      const params = new URLSearchParams();
      params.append('rollno', username);

      const response = await axios.post(`${BASE_URL}/Student/StudentGetToken`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Authorization': `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/Student/StudentView`,
          'Origin': 'https://edviewx.psgtech.ac.in',
          'User-Agent': 'Mozilla/5.0',
          ...(cookies ? { 'Cookie': cookies } : {})
        },
        timeout: 30000
      });

      console.log(`[Tokens] Response: ${response.status} | Data type: ${Array.isArray(response.data) ? 'Array' : typeof response.data}`);
      res.json(response.data);
    } catch (error: any) {
      console.error("[Tokens Error]:", error.response?.data || error.message);
      res.status(500).json({ 
        error: "Failed to fetch tokens from PSG Tech server", 
        details: error.response?.data || error.message 
      });
    }
  });

  // Fetch Leave Details Proxy
  app.post("/api/student/leaves", async (req, res) => {
    const { username, token, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!username || !token) {
      return res.status(400).json({ error: "Username and token are required" });
    }

    try {
      const response = await axios.get(`${BASE_URL}/Student/StudentGetLeav?rollno=${username}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/Student/StudentView`,
          'Origin': 'https://edviewx.psgtech.ac.in',
          'User-Agent': 'Mozilla/5.0',
          ...(cookies ? { 'Cookie': cookies } : {})
        },
        timeout: 30000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("[Leaves Error]:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to fetch leave details" });
    }
  });
  // Fetch Hostel Fees / Mess Balance Details Proxy
  app.post("/api/student/fees", async (req, res) => {
    const { username, token, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!username || !token) {
      return res.status(400).json({ error: "Username and token are required" });
    }

    try {
      console.log(`[Fees] Fetching fees details for ${username}...`);
      const feesParams = new URLSearchParams();
      feesParams.append('rollno', username);

      const response = await axios.post(`${BASE_URL}/Student/StudHosFeesDet?rollno=${username}`, feesParams.toString(), {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/Student/StudentView`,
          'Origin': 'https://edviewx.psgtech.ac.in',
          'User-Agent': 'Mozilla/5.0',
          ...(cookies ? { 'Cookie': cookies } : {})
        },
        timeout: 30000
      });
      res.json(response.data);
    } catch (error: any) {
      console.error("[Fees Error]:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to fetch fees details" });
    }
  });

  // Fetch Dynamic Booking Meta (HTML Dates + JS IDs)
  app.post("/api/booking/meta", async (req, res) => {
    const { token, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!token) {
      return res.status(400).json({ error: "Token is required" });
    }

    try {
      console.log(`[Booking] Scraping dynamic booking metadata...`);
      const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${BASE_URL}/Student/StudentView`,
        'User-Agent': 'Mozilla/5.0',
        ...(cookies ? { 'Cookie': cookies } : {})
      };

      // 1. Fetch StudentView HTML to extract available dates
      console.log(`[Booking] Fetching StudentView HTML...`);
      const htmlResp = await axios.get(`${BASE_URL}/Student/StudentView`, { 
        headers: authHeaders, 
        timeout: 15000 
      });
      
      if (!htmlResp.data || typeof htmlResp.data !== 'string') {
        console.error(`[Booking] StudentView response is not a valid string (${typeof htmlResp.data})`);
        return res.status(502).json({ error: "Invalid response from PSG Tech server (HTML)" });
      }

      console.log(`[Booking] StudentView response received (${htmlResp.data.length} bytes)`);
      const $ = cheerio.load(htmlResp.data);
      
      const dateMap: Record<string, string[]> = {};
      $('select').each((_, el) => {
        const sid = $(el).attr('id');
        if (sid) {
          const options: string[] = [];
          $(el).find('option').each((_, opt) => {
            const text = $(opt).text().trim();
            if (text && text !== "DATE") {
              options.push(text);
            }
          });
          if (options.length > 0) {
            dateMap[sid] = options;
          }
        }
      });

      // 2. Fetch Leave.js to extract PTOKEN_IDs
      console.log(`[Booking] Fetching Leave.js...`);
      const jsResp = await axios.get(`${BASE_URL}/assets/js/custom/Leave.js`, { 
        headers: authHeaders,
        timeout: 15000
      });

      if (!jsResp.data || typeof jsResp.data !== 'string') {
        console.error(`[Booking] Leave.js response is not a valid string (${typeof jsResp.data})`);
        return res.status(502).json({ error: "Invalid response from PSG Tech server (JS)" });
      }

      console.log(`[Booking] Leave.js response received (${jsResp.data.length} bytes)`);
      const jsContent = jsResp.data;
      
      const tokenMap: Record<string, string> = {};
      // Regex pattern from the Python script: KT uses click handlers to set PTOKEN_ID
      const pattern = /\$\("#([^"]+)"\)\.click\s*\(\s*function\s*\(\)\s*\{([\s\S]*?)\}/g;
      let match;
      while ((match = pattern.exec(jsContent)) !== null) {
        const name = match[1];
        const block = match[2];
        const tidMatch = /PTOKEN_ID\s*=\s*"?(\d+)"?/.exec(block);
        if (tidMatch) {
          const tokenId = tidMatch[1];
          const nameLower = name.toLowerCase();
          // Filter out generic UI items
          if (!nameLower.startsWith("btn") && !nameLower.startsWith("modal") && 
              !nameLower.startsWith("kt_") && !nameLower.startsWith("swal") && 
              !nameLower.startsWith("close")) {
            tokenMap[name] = tokenId;
          }
        }
      }

      // Add common mappings based on user script and typical PSG Tech naming conventions
      const foodDropdownMap: Record<string, string> = {
        "Gobichilli": "ddlgobi",
        "PanneerMasala": "ddlmushroommasal",
        "EggGraveytoken": "ddlEggGravey",
        "Chickentoken": "ddlchicken",
        "VegBiryanitoken": "ddlvegbiriyani",
        "FriedRicetoken": "ddlfriedrice",
        "MushroomManchuriantoken": "ddlmushroommanchurian",
        "Omelettetoken": "ddlomelette",
        "BoiledEggtoken": "ddlboiledegg",
        "FullBoilEggtoken": "ddlfullboil",
        "EggCurrytoken": "ddleggcurry",
        "EggDosatoken": "ddleggdosa",
        "snackstoken": "ddlsnacks"
      };

      // Combine into a structured list of available food items
      const availableItems = Object.entries(tokenMap).map(([name, id]) => {
        let dropdownId = foodDropdownMap[name];
        
        // Fuzzy matcher: If not in manual map, try to find a select ID in dateMap that matches keywords
        if (!dropdownId || !dateMap[dropdownId]) {
          const cleanName = name.replace(/token$/, '').toLowerCase();
          const possibleSid = Object.keys(dateMap).find(sid => {
            const sidLow = sid.toLowerCase().replace(/^ddl/, '');
            return sidLow.includes(cleanName) || cleanName.includes(sidLow);
          });
          if (possibleSid) dropdownId = possibleSid;
          else if (!dropdownId) dropdownId = `ddl${cleanName}`;
        }

        return {
          name,
          id,
          dropdownId,
          dates: dateMap[dropdownId] || []
        };
      }).filter(item => item.dates.length > 0);

      res.json({
         success: true,
         items: availableItems
      });

    } catch (error: any) {
      console.error("[Booking Meta Error]:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to scrape booking metadata" });
    }
  });

  // Book Token Proxy
  app.post("/api/tokens/book", async (req, res) => {
    const { username, token, tokenId, date, mealtime, qty, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!username || !token || !tokenId || !date || !mealtime) {
      console.error("[Booking] Missing required data:", { username, token: !!token, tokenId, date, mealtime });
      return res.status(400).json({ error: "Missing required booking data" });
    }

    try {
      console.log(`[Tokens] Booking token ${tokenId} for ${username} on ${date} (Qty: ${qty || 1})...`);
      const params = new URLSearchParams();
      params.append('PTOKEN_ID', tokenId);
      params.append('ddtokenqty', String(qty || '1'));
      params.append('Tokendatetime', date);
      params.append('MEALTIME', mealtime);

      const response = await axios.post(`${BASE_URL}/Student/newStudentTokenApply`, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Authorization': `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${BASE_URL}/Student/StudentView`,
          'Origin': 'https://edviewx.psgtech.ac.in',
          'User-Agent': 'Mozilla/5.0',
          ...(cookies ? { 'Cookie': cookies } : {})
        },
        timeout: 30000
      });

      console.log(`[Tokens] Booking Response:`, response.status, response.data);
      res.json(response.data);
    } catch (error: any) {
      console.error("[Booking Error]:", error.response?.data || error.message);
      res.status(500).json({ 
        error: "Failed to book token", 
        details: error.response?.data || error.message 
      });
    }
  });

  // Cancel Token Proxy
  app.post("/api/tokens/cancel", async (req, res) => {
    const { username, token, tokenName, tokenId, date, mealtime, type, cookies } = req.body;
    const BASE_URL = "https://edviewx.psgtech.ac.in/Hostel";

    if (!username || !token || !tokenName || !date || !mealtime) {
      return res.status(400).json({ error: "Missing required cancellation data" });
    }

    try {
      const endpoint = type === 'bulk' ? 'StudentTokenBulkCancel' : 'StudentTokenCancel';
      console.log(`[Tokens] ${type === 'bulk' ? 'Bulk ' : ''}Cancelling token ${tokenName} for ${username}...`);
      
      const commonHeaders = {
        'Authorization': `Bearer ${token}`,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${BASE_URL}/Student/StudentView`,
        'Origin': 'https://edviewx.psgtech.ac.in',
        'User-Agent': 'Mozilla/5.0',
        ...(cookies ? { 'Cookie': cookies } : {})
      };

      // Phase 1: Pre-flight StudentView load (required for session/referer validation by some ASP.NET servers)
      await axios.get(`${BASE_URL}/Student/StudentView`, { 
        headers: commonHeaders,
        timeout: 15000
      }).catch(e => {
        console.warn("[Cancel] Pre-flight GET failed, proceeding anyway...", e.message);
      });

      // Phase 2: Cancellation POST
      const params = new URLSearchParams();
      params.append('rollno', username);
      params.append('Tokenno', 'View');
      params.append('ISSUE_DATE', tokenName);
      params.append('TOKEN_ID', date);
      params.append('MEALTIME', mealtime);

      const response = await axios.post(`${BASE_URL}/Student/${endpoint}`, params.toString(), {
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        timeout: 30000
      });

      console.log(`[Tokens] ${type === 'bulk' ? 'Bulk ' : ''}Cancel Response:`, response.status, response.data);
      res.json(response.data);
    } catch (error: any) {
      console.error("Cancel Token Error:", error.response?.data || error.message);
      res.status(500).json({ 
        error: "Failed to cancel token", 
        details: error.response?.data || error.message 
      });
    }
  });

// Removed Vite middleware - no longer needed for Android API

  app.listen(PORT as number, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
