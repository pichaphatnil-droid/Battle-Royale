// ============================================================
// Database Types — English column names
// ============================================================

export type GameStatus = 'รอผู้เล่น' | 'กำลังเล่น' | 'หยุดชั่วคราว' | 'จบแล้ว'
export type UserRole = 'ผู้เล่น' | 'แอดมิน'
export type Gender = 'ชาย' | 'หญิง'
export type ChatChannel = 'ทั่วไป' | 'พื้นที่' | 'พันธมิตร'
export type AnnouncementType = 'ทั่วไป' | 'อาจารย์ผู้ควบคุม' | 'ส่วนตัว'
export type ItemCategory = 'อาวุธ' | 'ยา' | 'อาหาร' | 'อุปกรณ์' | 'วัสดุ'
export type TraitType = 'กาย' | 'จิตใจและสังคม' | 'ทักษะ' | 'ลบ'
export type MoodleType = 'กาย' | 'จิตใจ' | 'สังคม'

export interface InventoryItem { id: string; qty: number }
export interface ActiveMoodle { id: string; level: number; expires_at: string | null }

export interface User {
  id: string; email: string; role: UserRole; created_at: string
}

export interface Game {
  id: string; status: GameStatus; started_at: string | null
  ends_at: string | null; paused_at: string | null
  paused_duration: string; created_at: string
  winner_id: string | null; winner_name: string | null
  force_combat: boolean
}

export interface ItemDefinition {
  id: string; name: string; category: ItemCategory
  description: string | null; photo_url: string | null
  weight: number; data: Record<string, unknown>; created_at: string
}

export interface TraitDefinition {
  id: string; name: string; type: TraitType; description: string
  icon_url: string | null; bonus_points: number
  stat_effects: Record<string, number>
  special_effects: Record<string, unknown>
  special_condition: string | null; is_active: boolean
  created_at: string; updated_at: string
}

export interface MoodleLevel { level: number; description: string; effects: Record<string, unknown> }
export interface MoodleDefinition {
  id: string; name: string; type: MoodleType
  icon_url: string | null; border_color: string; max_level: number
  level_effects: MoodleLevel[]; cause: string | null; treatment: string | null
  is_active: boolean; created_at: string; updated_at: string
}

export interface CraftIngredient { id: string; qty: number }
export interface CraftRecipe {
  id: string; name: string; result_id: string; result_qty: number
  ingredients: CraftIngredient[]; ap_cost: number; min_int: number
  description: string | null; discoverable: boolean; is_active: boolean
  created_at: string; updated_at: string
}

export interface Grid {
  x: number; y: number; zone_name: string; terrain: string
  visibility: number; image_url: string | null; description: string | null
  spawn_table: Array<{ id: string; weight: number }>
}

export interface GridState {
  game_id: string; x: number; y: number; items: InventoryItem[]
  is_forbidden: boolean; warn_forbidden: boolean
  searched_at: string | null; respawn_at: string | null
}

export interface Player {
  id: string; game_id: string; user_id: string
  name: string; student_number: number; gender: Gender
  photo_url: string | null; photo_verified: boolean
  hp: number; max_hp: number; ap: number; ap_updated_at: string
  hunger: number; thirst: number; hunger_updated_at: string; thirst_updated_at: string
  str: number; agi: number; int: number; per: number
  cha: number; end_stat: number; stl: number; lck: number
  pos_x: number | null; pos_y: number | null
  is_alive: boolean; kill_count: number; is_banned: boolean; chat_muted: boolean
  traits: string[]; inventory: InventoryItem[]
  moodles: ActiveMoodle[]; known_recipes: string[]
  alliance_id: string | null
}

export interface Alliance {
  id: string; game_id: string; members: string[]
  trust_scores: Record<string, Record<string, number>>
  leader_id: string | null
  created_at: string; disbanded_at: string | null
}

export interface GameEvent {
  id: string; game_id: string; occurred_at: string; event_type: string
  actor_id: string | null; target_id: string | null
  pos_x: number | null; pos_y: number | null; data: Record<string, unknown>
}

export interface Announcement {
  id: string; game_id: string; occurred_at: string; ann_type: AnnouncementType
  message: string; target_id: string | null; sender_id: string | null
}

export interface ChatMessage {
  id: string; game_id: string; player_id: string; channel: ChatChannel
  pos_x: number | null; pos_y: number | null; alliance_id: string | null
  message: string; sent_at: string
  player?: Pick<Player, 'name' | 'student_number' | 'photo_url'>
}

export type Database = {
  public: {
    Tables: {
      users:              { Row: User;             Insert: Omit<User, 'created_at'>;                            Update: Partial<User> }
      games:              { Row: Game;             Insert: Omit<Game, 'id' | 'created_at'>;                     Update: Partial<Game> }
      item_definitions:   { Row: ItemDefinition;   Insert: Omit<ItemDefinition, 'created_at'>;                  Update: Partial<ItemDefinition> }
      trait_definitions:  { Row: TraitDefinition;  Insert: Omit<TraitDefinition, 'created_at' | 'updated_at'>; Update: Partial<TraitDefinition> }
      moodle_definitions: { Row: MoodleDefinition; Insert: Omit<MoodleDefinition, 'created_at' | 'updated_at'>; Update: Partial<MoodleDefinition> }
      craft_recipes:      { Row: CraftRecipe;      Insert: Omit<CraftRecipe, 'created_at' | 'updated_at'>;     Update: Partial<CraftRecipe> }
      grids:              { Row: Grid;             Insert: Grid;                                                 Update: Partial<Grid> }
      grid_states:        { Row: GridState;        Insert: Omit<GridState, 'is_forbidden' | 'warn_forbidden'>;  Update: Partial<GridState> }
      players:            { Row: Player;           Insert: Omit<Player, 'id' | 'is_alive' | 'kill_count' | 'is_banned' | 'chat_muted'>; Update: Partial<Player> }
      alliances:          { Row: Alliance;         Insert: Omit<Alliance, 'id' | 'created_at'>;                 Update: Partial<Alliance> }
      events:             { Row: GameEvent;        Insert: Omit<GameEvent, 'id' | 'occurred_at'>;               Update: never }
      announcements:      { Row: Announcement;     Insert: Omit<Announcement, 'id' | 'occurred_at'>;            Update: never }
      chat_messages:      { Row: ChatMessage;      Insert: Omit<ChatMessage, 'id' | 'sent_at'>;                 Update: never }
    }
    Functions: {
      is_admin: { Args: Record<string, never>; Returns: boolean }
      is_player_in_game: { Args: { gid: string }; Returns: boolean }
    }
  }
}
