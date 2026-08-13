export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      gear_items: {
        Row: {
          acquired_on: string | null
          brand: string | null
          category: string | null
          created_at: string
          currency: string | null
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          notes: string | null
          photo_path: string | null
          price: number | null
          quantity: number
          status: string
          updated_at: string
          url: string | null
          user_id: string
          weight: number
          weight_grams: number | null
          weight_unit: string
        }
        Insert: {
          acquired_on?: string | null
          brand?: string | null
          category?: string | null
          created_at?: string
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          notes?: string | null
          photo_path?: string | null
          price?: number | null
          quantity?: number
          status?: string
          updated_at?: string
          url?: string | null
          user_id?: string
          weight?: number
          weight_grams?: number | null
          weight_unit?: string
        }
        Update: {
          acquired_on?: string | null
          brand?: string | null
          category?: string | null
          created_at?: string
          currency?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          notes?: string | null
          photo_path?: string | null
          price?: number | null
          quantity?: number
          status?: string
          updated_at?: string
          url?: string | null
          user_id?: string
          weight?: number
          weight_grams?: number | null
          weight_unit?: string
        }
        Relationships: []
      }
      pack_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          pack_id: string
          position: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          pack_id: string
          position?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          pack_id?: string
          position?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pack_categories_user_id_pack_id_fkey"
            columns: ["user_id", "pack_id"]
            isOneToOne: false
            referencedRelation: "packs"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      pack_items: {
        Row: {
          consumable: boolean
          created_at: string
          gear_item_id: string | null
          id: string
          overrides: Json
          pack_category_id: string
          packed: boolean
          position: number
          quantity: number
          snapshot: Json | null
          updated_at: string
          user_id: string
          worn: boolean
        }
        Insert: {
          consumable?: boolean
          created_at?: string
          gear_item_id?: string | null
          id?: string
          overrides?: Json
          pack_category_id: string
          packed?: boolean
          position?: number
          quantity?: number
          snapshot?: Json | null
          updated_at?: string
          user_id?: string
          worn?: boolean
        }
        Update: {
          consumable?: boolean
          created_at?: string
          gear_item_id?: string | null
          id?: string
          overrides?: Json
          pack_category_id?: string
          packed?: boolean
          position?: number
          quantity?: number
          snapshot?: Json | null
          updated_at?: string
          user_id?: string
          worn?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "pack_items_user_id_gear_item_id_fkey"
            columns: ["user_id", "gear_item_id"]
            isOneToOne: false
            referencedRelation: "gear_items"
            referencedColumns: ["user_id", "id"]
          },
          {
            foreignKeyName: "pack_items_user_id_pack_category_id_fkey"
            columns: ["user_id", "pack_category_id"]
            isOneToOne: false
            referencedRelation: "pack_categories"
            referencedColumns: ["user_id", "id"]
          },
        ]
      }
      packs: {
        Row: {
          created_at: string
          description: string | null
          id: string
          locked_at: string | null
          name: string
          slug: string
          trip_type: string | null
          updated_at: string
          user_id: string
          visibility: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          locked_at?: string | null
          name: string
          slug?: string
          trip_type?: string | null
          updated_at?: string
          user_id?: string
          visibility?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          locked_at?: string | null
          name?: string
          slug?: string
          trip_type?: string | null
          updated_at?: string
          user_id?: string
          visibility?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      delete_own_account: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

